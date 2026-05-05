import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import * as zarr from "https://cdn.jsdelivr.net/npm/zarrita@0.6.2/+esm";

const CATALOG_URL = "https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv";
const WORLD_GEOJSON_URL = "https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson";

const DATASET_IDS = { SSP245: 63724, SSP370: 61597, SSP585: 63261 };
const OCEAN_COLOR = "#8ecae6";
const YEAR_AGG = 5;

const loadButton = document.querySelector("#load-button");
const coarsenInput = document.querySelector("#coarsen-input");
const yearAggInput = document.querySelector("#year-agg-input");
const statusEl = document.querySelector("#status");
const sliderEl = document.querySelector("#year-slider");
const yearLabelEl = document.querySelector("#year-label");
const legendSvg = d3.select("#legend-svg");

const canvases = {
	SSP245: document.querySelector("#canvas-ssp245"),
	SSP370: document.querySelector("#canvas-ssp370"),
	SSP585: document.querySelector("#canvas-ssp585"),
};

const tooltipByScenario = {
	SSP245: document.querySelector(".map-card[data-scenario='SSP245'] .tooltip"),
	SSP370: document.querySelector(".map-card[data-scenario='SSP370'] .tooltip"),
	SSP585: document.querySelector(".map-card[data-scenario='SSP585'] .tooltip"),
};

let catalogRows = null;
let worldGeoJson = null;
let state = null;
let currentRequestId = 0;

function setStatus(message, type = "") {
	statusEl.textContent = message;
	statusEl.className = type;
}

function gsToHttp(gsPath) {
	return gsPath.startsWith("gs://") ? `https://storage.googleapis.com/${gsPath.slice(5)}` : gsPath;
}

async function loadCatalog() {
	if (!catalogRows) {
		const csvText = await d3.text(CATALOG_URL);
		catalogRows = d3.csvParse(csvText);
	}
	return catalogRows;
}

async function loadWorldGeoJson() {
	if (!worldGeoJson) {
		const response = await fetch(WORLD_GEOJSON_URL);
		if (!response.ok) throw new Error(`Failed to fetch world outline (${response.status})`);
		worldGeoJson = await response.json();
	}
	return worldGeoJson;
}

function toArray(result, expectedShape = null) {
	if (ArrayBuffer.isView(result)) return { data: result, shape: expectedShape };
	if (result?.data && ArrayBuffer.isView(result.data)) return { data: result.data, shape: result.shape || expectedShape };
	if (Array.isArray(result)) return { data: Float64Array.from(result.flat(Infinity)), shape: expectedShape };
	throw new Error("Unsupported zarr array response format.");
}

function parseTimeUnits(units) {
	const match = typeof units === "string" ? units.match(/(days|hours|seconds)\s+since\s+(.+)/i) : null;
	if (!match) return null;
	return { unit: match[1].toLowerCase(), origin: new Date(`${match[2].trim().replace(" ", "T")}Z`) };
}

function decodeYears(timeData, units) {
	const parsed = parseTimeUnits(units);
	if (!parsed) return Array.from({ length: timeData.length }, (_, i) => i);
	const msPerUnit = parsed.unit === "days" ? 86400000 : parsed.unit === "hours" ? 3600000 : 1000;
	return Array.from(timeData, (value) => new Date(parsed.origin.getTime() + Number(value) * msPerUnit).getUTCFullYear());
}

function downsampleCoords(coord, factor) {
	const out = new Float64Array(Math.floor(coord.length / factor));
	for (let i = 0; i < out.length; i += 1) {
		let sum = 0;
		for (let j = 0; j < factor; j += 1) sum += Number(coord[i * factor + j]);
		out[i] = sum / factor;
	}
	return out;
}

function normalizeLonForGeoJson(lon) {
	return lon > 180 ? lon - 360 : lon;
}

function buildLandMask(lons, lats, world) {
	const mask = new Uint8Array(lons.length * lats.length);
	for (let y = 0; y < lats.length; y += 1) {
		for (let x = 0; x < lons.length; x += 1) {
			mask[y * lons.length + x] = d3.geoContains(world, [normalizeLonForGeoJson(Number(lons[x])), Number(lats[y])]) ? 1 : 0;
		}
	}
	return mask;
}

function compute5YearRaw(values, years, nLat, nLon, yearAgg) {
	const firstYear = years[0];
	const binIndex = new Int32Array(years.length);
	let nBins = 0;
	for (let t = 0; t < years.length; t += 1) {
		const idx = Math.floor((years[t] - firstYear) / yearAgg);
		binIndex[t] = idx;
		nBins = Math.max(nBins, idx + 1);
	}

	const sums = Array.from({ length: nBins }, () => new Float32Array(nLat * nLon));
	const counts = Array.from({ length: nBins }, () => new Uint16Array(nLat * nLon));
	for (let t = 0; t < years.length; t += 1) {
		const bin = binIndex[t];
		const offset = t * nLat * nLon;
		for (let i = 0; i < nLat * nLon; i += 1) {
			const v = values[offset + i];
			if (Number.isFinite(v)) {
				sums[bin][i] += v;
				counts[bin][i] += 1;
			}
		}
	}

	const yearly = sums.map((sum, bin) => {
		const out = new Float32Array(nLat * nLon);
		const count = counts[bin];
		for (let i = 0; i < out.length; i += 1) out[i] = count[i] > 0 ? sum[i] / count[i] : Number.NaN;
		return out;
	});

	return { yearly, yearlyYears: Array.from({ length: nBins }, (_, bin) => firstYear + bin * yearAgg) };
}

function computeAnomaly(rawFrames) {
	const baseline = rawFrames[0];
	return rawFrames.map((frame) => {
		const out = new Float32Array(frame.length);
		for (let i = 0; i < frame.length; i += 1) {
			const v = frame[i];
			const b = baseline[i];
			out[i] = Number.isFinite(v) && Number.isFinite(b) ? v - b : Number.NaN;
		}
		return out;
	});
}

function computeVmaxQuantile(allScenarioFrames, q = 0.99) {
	const vals = [];
	for (const frames of Object.values(allScenarioFrames)) {
		for (const frame of frames) {
			for (let i = 0; i < frame.length; i += 1) {
				const v = Math.abs(frame[i]);
				if (Number.isFinite(v)) vals.push(v);
			}
		}
	}
	vals.sort((a, b) => a - b);
	return vals.length ? vals[Math.min(vals.length - 1, Math.floor(q * vals.length))] || 1 : 1;
}

function createColorScale(vmax) {
	return d3.scaleSequential(d3.interpolateBrBG).domain([-vmax, vmax]);
}

function syncCanvasSize(canvas) {
	const dpr = window.devicePixelRatio || 1;
	const rect = canvas.getBoundingClientRect();
	const width = Math.max(1, Math.round(rect.width * dpr));
	const height = Math.max(1, Math.round(rect.height * dpr));
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
	return { width: rect.width, height: rect.height };
}

function drawHeatmap(canvas, frame, data, colorScale) {
	const { dims, landMask } = data;
	const { nLat, nLon } = dims;
	const ctx = canvas.getContext("2d", { alpha: false });
	const { width, height } = syncCanvasSize(canvas);
	const cellWidth = width / nLon;
	const cellHeight = height / nLat;

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
	ctx.imageSmoothingEnabled = false;
	ctx.fillStyle = OCEAN_COLOR;
	ctx.fillRect(0, 0, width, height);

	for (let y = 0; y < nLat; y += 1) {
		for (let x = 0; x < nLon; x += 1) {
			if (!landMask[y * nLon + x]) continue;
			const v = frame[y * nLon + x];
			if (!Number.isFinite(v)) continue;
			ctx.fillStyle = colorScale(v);
			ctx.fillRect(Math.floor(x * cellWidth), Math.floor((nLat - 1 - y) * cellHeight), Math.ceil(cellWidth) + 1, Math.ceil(cellHeight) + 1);
		}
	}
}

function drawLegend(vmax, colorScale) {
	const width = 860;
	const height = 56;
	const margin = { top: 8, right: 20, bottom: 20, left: 20 };
	const innerWidth = width - margin.left - margin.right;
	legendSvg.selectAll("*").remove();
	legendSvg.attr("viewBox", `0 0 ${width} ${height}`);

	const defs = legendSvg.append("defs");
	const gradient = defs.append("linearGradient").attr("id", "legend-gradient").attr("x1", "0%").attr("y1", "0%").attr("x2", "100%").attr("y2", "0%");
	for (let i = 0; i <= 100; i += 1) gradient.append("stop").attr("offset", `${i}%`).attr("stop-color", colorScale(-vmax + (i / 100) * 2 * vmax));

	legendSvg.append("rect").attr("x", margin.left).attr("y", margin.top).attr("width", innerWidth).attr("height", 12).attr("fill", "url(#legend-gradient)").attr("stroke", "#6d7d85").attr("stroke-width", 0.5);
	const scale = d3.scaleLinear().domain([vmax, -vmax]).range([margin.left, margin.left + innerWidth]);
	legendSvg.append("g").attr("transform", `translate(0, ${margin.top + 12})`).call(d3.axisBottom(scale).ticks(7).tickFormat(d3.format(".2~g"))).call((g) => g.select(".domain").attr("stroke", "#55656d")).call((g) => g.selectAll("line").attr("stroke", "#55656d")).call((g) => g.selectAll("text").attr("fill", "#33464f").attr("font-size", 11));
	legendSvg.append("text").attr("x", margin.left).attr("y", 52).attr("fill", "#33464f").attr("font-size", 11).text("cVeg anomaly");
}

function attachTooltipHandlers(scenario) {
	const canvas = canvases[scenario];
	const tooltip = tooltipByScenario[scenario];
	canvas.addEventListener("mousemove", (evt) => {
		if (!state) return;
		const item = state.processed[scenario];
		const rect = canvas.getBoundingClientRect();
		const x = evt.clientX - rect.left;
		const y = evt.clientY - rect.top;
		const iLon = Math.floor((x / rect.width) * item.dims.nLon);
		const iLat = item.dims.nLat - 1 - Math.floor((y / rect.height) * item.dims.nLat);
		if (iLon < 0 || iLon >= item.dims.nLon || iLat < 0 || iLat >= item.dims.nLat) {
			tooltip.style.opacity = "0";
			return;
		}
		const value = item.anomFrames[state.frameIndex][iLat * item.dims.nLon + iLon];
		tooltip.style.opacity = "1";
		tooltip.style.left = `${x}px`;
		tooltip.style.top = `${y}px`;
		tooltip.textContent = `Year ${state.years[state.frameIndex]} | Lat ${item.lats[iLat].toFixed(2)} | Lon ${item.lons[iLon].toFixed(2)} | ${Number.isFinite(value) ? value.toFixed(3) : "NaN"}`;
	});
	canvas.addEventListener("mouseleave", () => {
		tooltip.style.opacity = "0";
	});
}

async function openGroupFromCatalogId(id) {
	const rows = await loadCatalog();
	const row = rows[id];
	if (!row) throw new Error(`Catalog index ${id} not found.`);
	const store = new zarr.FetchStore(gsToHttp(row.zstore));
	const wrappedStore = await zarr.tryWithConsolidated(store);
	return { group: await zarr.open(zarr.root(wrappedStore), { kind: "group" }) };
}

async function loadCvegFromGroup(group, coarsenFactor, yearAgg) {
	const cvegNode = await zarr.open(group.resolve("cVeg"), { kind: "array" });
	const latNode = await zarr.open(group.resolve("lat"), { kind: "array" });
	const lonNode = await zarr.open(group.resolve("lon"), { kind: "array" });
	const timeNode = await zarr.open(group.resolve("time"), { kind: "array" });

	const cveg = toArray(await zarr.get(cvegNode, null), cvegNode.shape);
	const lat = toArray(await zarr.get(latNode, null), latNode.shape);
	const lon = toArray(await zarr.get(lonNode, null), lonNode.shape);
	const time = toArray(await zarr.get(timeNode, null), timeNode.shape);

	const [nTime, nLatFull, nLonFull] = cveg.shape;
	const nLat = Math.floor(nLatFull / coarsenFactor);
	const nLon = Math.floor(nLonFull / coarsenFactor);
	const coarsened = new Float32Array(nTime * nLat * nLon);

	for (let t = 0; t < nTime; t += 1) {
		const srcT = t * nLatFull * nLonFull;
		const dstT = t * nLat * nLon;
		for (let y = 0; y < nLat; y += 1) {
			for (let x = 0; x < nLon; x += 1) {
				const values = [];
				for (let dy = 0; dy < coarsenFactor; dy += 1) {
					for (let dx = 0; dx < coarsenFactor; dx += 1) {
						values.push(cveg.data[srcT + (y * coarsenFactor + dy) * nLonFull + (x * coarsenFactor + dx)]);
					}
				}
				let sum = 0;
				let count = 0;
				for (const value of values) {
					if (Number.isFinite(value)) {
						sum += value;
						count += 1;
					}
				}
				coarsened[dstT + y * nLon + x] = count ? sum / count : Number.NaN;
			}
		}
	}

	const years = decodeYears(time.data, timeNode.attrs?.units);
	const raw = compute5YearRaw(coarsened, years, nLat, nLon, yearAgg);
	return { rawFrames: raw.yearly, years: raw.yearlyYears, lats: downsampleCoords(lat.data, coarsenFactor), lons: downsampleCoords(lon.data, coarsenFactor), dims: { nLat, nLon } };
}

function renderFrame(frameIndex) {
	if (!state) return;
	state.frameIndex = frameIndex;
	yearLabelEl.textContent = `Year: ${state.years[frameIndex]}`;
	for (const scenario of Object.keys(DATASET_IDS)) {
		const item = state.processed[scenario];
		drawHeatmap(canvases[scenario], item.anomFrames[frameIndex], item, state.colorScale);
	}
}

async function loadAndCompute() {
	const requestId = ++currentRequestId;
	const coarsenFactor = Math.max(1, Math.floor(Number(coarsenInput.value) || 1));
	const yearAgg = Math.max(1, Math.floor(Number(yearAggInput.value) || 1));
	coarsenInput.value = String(coarsenFactor);
	yearAggInput.value = String(yearAgg);
	setStatus("Loading world outline and catalog...");
	const world = await loadWorldGeoJson();
	const processed = {};
	for (const [scenario, id] of Object.entries(DATASET_IDS)) {
		if (requestId !== currentRequestId) return;
		setStatus(`Opening ${scenario} zarr store and computing cVeg anomaly...`);
		const { group } = await openGroupFromCatalogId(id);
		const loaded = await loadCvegFromGroup(group, coarsenFactor, yearAgg);
		loaded.landMask = buildLandMask(loaded.lons, loaded.lats, world);
		processed[scenario] = { ...loaded, anomFrames: computeAnomaly(loaded.rawFrames) };
	}
	if (requestId !== currentRequestId) return;

	const years = processed.SSP245.years;
	const vmax = computeVmaxQuantile({ SSP245: processed.SSP245.anomFrames, SSP370: processed.SSP370.anomFrames, SSP585: processed.SSP585.anomFrames });
	const colorScale = createColorScale(vmax);
	state = { years, processed, colorScale, vmax, frameIndex: 0, coarsenFactor, yearAgg };

	drawLegend(vmax, colorScale);
	sliderEl.min = "0";
	sliderEl.max = String(years.length - 1);
	sliderEl.value = "0";
	sliderEl.disabled = false;
	for (const scenario of Object.keys(DATASET_IDS)) attachTooltipHandlers(scenario);
	renderFrame(0);
	setStatus(`Loaded and rendered all SSP anomaly maps with coarsening ${coarsenFactor} and ${yearAgg}-year bins.`, "status-ok");
	window.cvegD3State = state;
}

sliderEl.addEventListener("input", () => renderFrame(Number(sliderEl.value)));

loadButton.addEventListener("click", async () => {
	loadButton.disabled = true;
	sliderEl.disabled = true;
	try {
		await loadAndCompute();
	} catch (error) {
		console.error(error);
		setStatus(`Load failed: ${error.message}`, "status-warn");
	} finally {
		loadButton.disabled = false;
	}
});