import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";
import * as zarr from "https://cdn.jsdelivr.net/npm/zarrita@0.6.2/+esm";

const CATALOG_URL = "https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv";
const WORLD_GEOJSON_URL = "https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson";

const DATASET_IDS = { SSP245: 63724, SSP370: 61597, SSP585: 63261 };
const OCEAN_COLOR = "#8ecae6";
const VIEWPORT_PRESETS = {
	global: { label: "Global", lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 },
	"south-america": { label: "South America", lonMin: -90, lonMax: -30, latMin: -60, latMax: 15 },
	"north-america": { label: "North America", lonMin: -170, lonMax: -50, latMin: 5, latMax: 80 },
	europe: { label: "Europe", lonMin: -25, lonMax: 45, latMin: 30, latMax: 72 },
	africa: { label: "Africa", lonMin: -20, lonMax: 55, latMin: -35, latMax: 38 },
	asia: { label: "Asia", lonMin: 25, lonMax: 180, latMin: -10, latMax: 80 },
	oceania: { label: "Oceania", lonMin: 90, lonMax: 180, latMin: -50, latMax: 10 },
};

const loadButton = document.querySelector("#load-button");
const coarsenInput = document.querySelector("#coarsen-input");
const yearAggInput = document.querySelector("#year-agg-input");
const viewportSelect = document.querySelector("#viewport-select");
const statusEl = document.querySelector("#status");
const sliderEl = document.querySelector("#year-slider");
const yearLabelEl = document.querySelector("#year-label");
const legendSvg = d3.select("#legend-svg");
const loadingOverlay = document.querySelector("#loading-overlay");
const loadingMessage = document.querySelector("#loading-message");

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
let currentViewportKey = viewportSelect.value;

function setStatus(message, type = "") {
	statusEl.textContent = message;
	statusEl.className = type;
	if (loadingMessage) loadingMessage.textContent = message;
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

function normalizeLon(lon) {
	return lon > 180 ? lon - 360 : lon;
}

function getViewport(viewportKey) {
	return VIEWPORT_PRESETS[viewportKey] || VIEWPORT_PRESETS.global;
}

function estimateCoordStep(coords) {
	if (!coords || coords.length < 2) return 1;
	let sum = 0;
	let count = 0;
	for (let i = 1; i < coords.length; i += 1) {
		const diff = Math.abs(Number(coords[i]) - Number(coords[i - 1]));
		if (Number.isFinite(diff) && diff > 0) {
			sum += diff;
			count += 1;
		}
	}
	return count ? sum / count : 1;
}

function buildLandMask(lons, lats, world) {
	const mask = new Uint8Array(lons.length * lats.length);
	for (let y = 0; y < lats.length; y += 1) {
		for (let x = 0; x < lons.length; x += 1) {
			mask[y * lons.length + x] = d3.geoContains(world, [normalizeLon(Number(lons[x])), Number(lats[y])]) ? 1 : 0;
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
	return d3.scaleSequential(d3.interpolateRdYlGn).domain([-vmax, vmax]);
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

function drawHeatmap(canvas, frame, data, colorScale, viewport) {
	const { dims, landMask, coordSteps } = data;
	const lons = data.lons;
	const lats = data.lats;
	const { nLat, nLon } = dims;
	const ctx = canvas.getContext("2d", { alpha: false });
	const { width, height } = syncCanvasSize(canvas);
	const lonSpan = viewport.lonMax - viewport.lonMin;
	const latSpan = viewport.latMax - viewport.latMin;
	const cellWidth = (width * coordSteps.lon) / lonSpan;
	const cellHeight = (height * coordSteps.lat) / latSpan;

	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
	ctx.imageSmoothingEnabled = false;
	ctx.fillStyle = OCEAN_COLOR;
	ctx.fillRect(0, 0, width, height);

	for (let y = 0; y < nLat; y += 1) {
		const lat = Number(lats[y]);
		if (lat < viewport.latMin - coordSteps.lat / 2 || lat > viewport.latMax + coordSteps.lat / 2) continue;
		const yCenter = ((viewport.latMax - lat) / latSpan) * height;
		for (let x = 0; x < nLon; x += 1) {
			const lon = Number(lons[x]);
			if (lon < viewport.lonMin - coordSteps.lon / 2 || lon > viewport.lonMax + coordSteps.lon / 2) continue;
			const xCenter = ((lon - viewport.lonMin) / lonSpan) * width;
			if (!landMask[y * nLon + x]) continue;
			const v = frame[y * nLon + x];
			if (!Number.isFinite(v)) continue;
			ctx.fillStyle = colorScale(v);
			ctx.fillRect(Math.floor(xCenter - cellWidth / 2), Math.floor(yCenter - cellHeight / 2), Math.ceil(cellWidth) + 1, Math.ceil(cellHeight) + 1);
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
		const viewport = state.viewport;
		const rect = canvas.getBoundingClientRect();
		const x = evt.clientX - rect.left;
		const y = evt.clientY - rect.top;
		const lon = viewport.lonMin + (x / rect.width) * (viewport.lonMax - viewport.lonMin);
		const lat = viewport.latMax - (y / rect.height) * (viewport.latMax - viewport.latMin);
		let iLon = 0;
		let lonDiff = Infinity;
		for (let ix = 0; ix < item.lons.length; ix += 1) {
			const diff = Math.abs(Number(item.lons[ix]) - lon);
			if (diff < lonDiff) {
				lonDiff = diff;
				iLon = ix;
			}
		}
		let iLat = 0;
		let latDiff = Infinity;
		for (let iy = 0; iy < item.lats.length; iy += 1) {
			const diff = Math.abs(Number(item.lats[iy]) - lat);
			if (diff < latDiff) {
				latDiff = diff;
				iLat = iy;
			}
		}
		if (iLon < 0 || iLon >= item.dims.nLon || iLat < 0 || iLat >= item.dims.nLat) {
			tooltip.style.opacity = "0";
			return;
		}
		const value = item.anomFrames[state.frameIndex][iLat * item.dims.nLon + iLon];
		tooltip.style.opacity = "1";
		tooltip.style.left = `${x}px`;
		tooltip.style.top = `${y}px`;
		tooltip.textContent = `Year ${state.years[state.frameIndex]} | Lat ${Number(item.lats[iLat]).toFixed(2)} | Lon ${Number(item.lons[iLon]).toFixed(2)} | ${Number.isFinite(value) ? value.toFixed(3) : "NaN"}`;
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
	const lats = Array.from(downsampleCoords(lat.data, coarsenFactor));
	const lonRaw = downsampleCoords(lon.data, coarsenFactor);
	return {
		rawFrames: raw.yearly,
		years: raw.yearlyYears,
		lats,
		lons: Array.from(lonRaw, normalizeLon),
		coordSteps: { lat: estimateCoordStep(lats), lon: estimateCoordStep(lonRaw) },
		dims: { nLat, nLon },
	};
}

function computeGlobalMeans(processed) {
	const means = {};
	for (const [scenario, item] of Object.entries(processed)) {
		means[scenario] = item.anomFrames.map((frame) => {
			let sum = 0;
			let count = 0;
			for (let i = 0; i < frame.length; i += 1) {
				const v = frame[i];
				if (Number.isFinite(v)) { sum += v; count += 1; }
			}
			return count ? sum / count : Number.NaN;
		});
	}
	return means;
}

function drawTimeseries(appState) {
	const { years } = appState;
	const means = computeGlobalMeans(appState.processed);

	const margin = { top: 32, right: 110, bottom: 64, left: 68 };
	const totalWidth = 860;
	const totalHeight = 250;
	const w = totalWidth - margin.left - margin.right;
	const h = totalHeight - margin.top - margin.bottom;

	d3.select("#timeseries-svg").remove();
	d3.select(".ts-tooltip").remove();

	const svg = d3.select("#timeseries-container")
		.append("svg")
		.attr("id", "timeseries-svg")
		.attr("viewBox", `0 0 ${totalWidth} ${totalHeight}`)
		.style("width", "100%")
		.style("height", "auto");

	const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

	const allVals = Object.values(means).flat().filter(Number.isFinite);
	const xScale = d3.scaleLinear().domain(d3.extent(years)).range([0, w]);
	const yScale = d3.scaleLinear().domain(d3.extent(allVals)).nice().range([h, 0]);

	const colors = { SSP245: "#4a90d9", SSP370: "#e07b39", SSP585: "#c0392b" };

	// Subtle horizontal grid
	g.append("g")
		.call(d3.axisLeft(yScale).ticks(5).tickSize(-w))
		.call((ax) => ax.select(".domain").remove())
		.call((ax) => ax.selectAll(".tick line").attr("stroke", "#ede8e0").attr("stroke-dasharray", "2,2"))
		.call((ax) => ax.selectAll(".tick text").remove());

	// Zero reference line
	g.append("line")
		.attr("x1", 0).attr("x2", w)
		.attr("y1", yScale(0)).attr("y2", yScale(0))
		.attr("stroke", "#aaa").attr("stroke-width", 1).attr("stroke-dasharray", "4,3");

	// Lines + end labels
	const lineGen = d3.line()
		.x((_, i) => xScale(years[i]))
		.y((v) => yScale(v))
		.defined((v) => Number.isFinite(v));

	for (const [scenario, vals] of Object.entries(means)) {
		g.append("path")
			.datum(vals)
			.attr("fill", "none")
			.attr("stroke", colors[scenario])
			.attr("stroke-width", 2.5)
			.attr("stroke-linejoin", "round")
			.attr("d", lineGen);

		const lastVal = vals.at(-1);
		if (Number.isFinite(lastVal)) {
			g.append("text")
				.attr("x", xScale(years.at(-1)) + 7)
				.attr("y", yScale(lastVal))
				.attr("dominant-baseline", "middle")
				.attr("fill", colors[scenario])
				.attr("font-size", 12)
				.attr("font-weight", 600)
				.text(scenario);
		}
	}

	// Axes
	g.append("g")
		.attr("transform", `translate(0,${h})`)
		.call(d3.axisBottom(xScale).ticks(8).tickFormat(d3.format("d")))
		.call((ax) => ax.selectAll("text")
			.attr("transform", "rotate(-40)")
			.attr("text-anchor", "end")
			.attr("dx", "-0.4em")
			.attr("dy", "0.2em"));
	g.append("g").call(d3.axisLeft(yScale).ticks(5));

	// Y-axis label only (year is obvious from slanted labels)
	g.append("text")
		.attr("transform", "rotate(-90)")
		.attr("x", -h / 2).attr("y", -56)
		.attr("text-anchor", "middle").attr("font-size", 12).attr("fill", "#55656d")
		.text("Global Mean Anomaly (kg C m⁻²)");

	// Chart title (describes transformations per rubric)
	svg.append("text")
		.attr("x", margin.left + w / 2).attr("y", 20)
		.attr("text-anchor", "middle").attr("font-size", 13).attr("font-weight", 700).attr("fill", "#202a30")
		.text(`cVeg Anomaly — ${appState.yearAgg}-yr means, relative to ${years[0]} baseline (BCC-CSM2-MR, spatially coarsened ×${appState.coarsenFactor})`);

	// Vertical indicator (linked to slider)
	const indicator = g.append("line")
		.attr("y1", 0).attr("y2", h)
		.attr("stroke", "#202a30").attr("stroke-width", 1.5).attr("stroke-dasharray", "5,3")
		.attr("pointer-events", "none").style("opacity", 0);

	// Hover dots
	const dots = {};
	for (const scenario of Object.keys(means)) {
		dots[scenario] = g.append("circle")
			.attr("r", 5).attr("fill", colors[scenario])
			.attr("stroke", "#fff").attr("stroke-width", 1.5)
			.attr("pointer-events", "none").style("opacity", 0);
	}

	// Floating tooltip div
	const tooltipDiv = d3.select("#timeseries-container")
		.append("div")
		.attr("class", "ts-tooltip")
		.style("opacity", 0)
		.style("background", "rgba(24,33,36,0.9)")
		.style("color", "#fff")
		.style("border-radius", "6px")
		.style("padding", "0.4rem 0.6rem")
		.style("font-size", "0.78rem")
		.style("line-height", "1.55")
		.style("white-space", "nowrap");

	function highlightIndex(idx, mouseX, mouseY) {
		const year = years[idx];
		indicator.attr("x1", xScale(year)).attr("x2", xScale(year)).style("opacity", 1);
		const lines = [`<strong>Year ${year}</strong>`];
		for (const [scenario, vals] of Object.entries(means)) {
			const v = vals[idx];
			dots[scenario]
				.attr("cx", xScale(year))
				.attr("cy", Number.isFinite(v) ? yScale(v) : -9999)
				.style("opacity", Number.isFinite(v) ? 1 : 0);
			lines.push(`<span style="color:${colors[scenario]}">${scenario}</span>: ${Number.isFinite(v) ? v.toFixed(4) : "N/A"}`);
		}
		tooltipDiv.html(lines.join("<br>")).style("opacity", 1)
			.style("left", `${mouseX + 14}px`).style("top", `${mouseY - 14}px`);
	}

	// Interaction overlay
	g.append("rect")
		.attr("width", w).attr("height", h)
		.attr("fill", "transparent").attr("cursor", "crosshair")
		.on("mousemove", function (event) {
			const [mx] = d3.pointer(event);
			const idx = d3.minIndex(years, (y) => Math.abs(y - xScale.invert(mx)));
			const containerEl = document.getElementById("timeseries-container");
			const cr = containerEl.getBoundingClientRect();
			highlightIndex(idx, event.clientX - cr.left, event.clientY - cr.top);
		})
		.on("click", function (event) {
			const [mx] = d3.pointer(event);
			const idx = d3.minIndex(years, (y) => Math.abs(y - xScale.invert(mx)));
			sliderEl.value = String(idx);
			renderFrame(idx);
		})
		.on("mouseleave", function () {
			tooltipDiv.style("opacity", 0);
			for (const dot of Object.values(dots)) dot.style("opacity", 0);
		});

	// Sync indicator when slider moves
	appState.updateTsIndicator = (frameIndex) => {
		indicator.attr("x1", xScale(years[frameIndex])).attr("x2", xScale(years[frameIndex])).style("opacity", 1);
		for (const dot of Object.values(dots)) dot.style("opacity", 0);
	};

	appState.updateTsIndicator(appState.frameIndex);
}

function renderFrame(frameIndex) {
	if (!state) return;
	state.frameIndex = frameIndex;
	yearLabelEl.textContent = `Year: ${state.years[frameIndex]}`;
	const viewport = state.viewport;
	for (const scenario of Object.keys(DATASET_IDS)) {
		const item = state.processed[scenario];
		drawHeatmap(canvases[scenario], item.anomFrames[frameIndex], item, state.colorScale, viewport);
	}
	if (state.updateTsIndicator) state.updateTsIndicator(frameIndex);
}

function applyViewportSelection() {
	currentViewportKey = viewportSelect.value;
	if (!state) return;
	state.viewportKey = currentViewportKey;
	state.viewport = getViewport(currentViewportKey);
	renderFrame(state.frameIndex);
}

async function loadFromPrecomputed() {
	const response = await fetch("./cveg_precomputed.json");
	if (!response.ok) throw new Error("Precomputed file not found");
	const json = await response.json();
	const processed = {};
	for (const scenario of Object.keys(DATASET_IDS)) {
		const sd = json[scenario];
		// Derive land mask from data — cVeg is land-only so ocean cells are null
		const refFrame = sd.frames[0];
		const landMask = new Uint8Array(refFrame.length);
		for (let i = 0; i < refFrame.length; i++) landMask[i] = refFrame[i] !== null ? 1 : 0;

		const anomFrames = sd.frames.map((frame) => {
			const arr = new Float32Array(frame.length);
			for (let i = 0; i < frame.length; i++) arr[i] = frame[i] === null ? NaN : frame[i];
			return arr;
		});
		const lats = sd.lats;
		const lons = sd.lons;
		processed[scenario] = {
			anomFrames,
			years: sd.years,
			lats,
			lons,
			dims: { nLat: sd.nLat, nLon: sd.nLon },
			coordSteps: { lat: estimateCoordStep(lats), lon: estimateCoordStep(lons) },
			landMask,
		};
	}
	return { processed, years: json.SSP245.years };
}

async function loadFromZarr(coarsenFactor, yearAgg, requestId) {
	const processed = {};
	for (const [scenario, id] of Object.entries(DATASET_IDS)) {
		if (requestId !== currentRequestId) return null;
		setStatus(`Opening ${scenario} zarr store and computing cVeg anomaly...`);
		const { group } = await openGroupFromCatalogId(id);
		const loaded = await loadCvegFromGroup(group, coarsenFactor, yearAgg);
		const world = await loadWorldGeoJson();
		loaded.landMask = buildLandMask(loaded.lons, loaded.lats, world);
		processed[scenario] = { ...loaded, anomFrames: computeAnomaly(loaded.rawFrames) };
	}
	return { processed, years: processed.SSP245.years };
}

async function loadAndCompute() {
	const requestId = ++currentRequestId;
	const coarsenFactor = Math.max(1, Math.floor(Number(coarsenInput.value) || 1));
	const yearAgg = Math.max(1, Math.floor(Number(yearAggInput.value) || 1));
	coarsenInput.value = String(coarsenFactor);
	yearAggInput.value = String(yearAgg);
	loadingOverlay.classList.remove("hidden");
	let processed, years;

	if (coarsenFactor === 2 && yearAgg === 5) {
		try {
			setStatus("Loading precomputed data...");
			({ processed, years } = await loadFromPrecomputed());
		} catch {
			setStatus("Precomputed file not found — loading from API (this may take a while)...");
			const result = await loadFromZarr(coarsenFactor, yearAgg, requestId);
			if (!result) return;
			({ processed, years } = result);
		}
	} else {
		setStatus("Custom settings — loading from API (this may take a while)...");
		const result = await loadFromZarr(coarsenFactor, yearAgg, requestId);
		if (!result) return;
		({ processed, years } = result);
	}

	if (requestId !== currentRequestId) return;
	const vmax = computeVmaxQuantile({ SSP245: processed.SSP245.anomFrames, SSP370: processed.SSP370.anomFrames, SSP585: processed.SSP585.anomFrames });
	const colorScale = createColorScale(vmax);
	state = { years, processed, colorScale, vmax, frameIndex: 0, coarsenFactor, yearAgg, viewportKey: currentViewportKey, viewport: getViewport(currentViewportKey) };

	drawLegend(vmax, colorScale);
	sliderEl.min = "0";
	sliderEl.max = String(years.length - 1);
	sliderEl.value = "0";
	sliderEl.disabled = false;
	for (const scenario of Object.keys(DATASET_IDS)) attachTooltipHandlers(scenario);
	renderFrame(0);
	drawTimeseries(state);
	loadingOverlay.classList.add("hidden");
	document.querySelector("#map-caption").textContent =
		`Each map shows how much vegetation carbon (cVeg) has changed compared to the 2015 baseline. ` +
		`Monthly model output was grouped into ${yearAgg}-year averages, and every ${coarsenFactor}×${coarsenFactor} block of grid cells was merged into one — ` +
		`then the difference from the first time step was calculated to show the anomaly.`;
	setStatus(`Loaded — ${yearAgg}-year bins, coarsening ×${coarsenFactor}, focused on ${state.viewport.label}.`, "status-ok");
	window.cvegD3State = state;
}

sliderEl.addEventListener("input", () => renderFrame(Number(sliderEl.value)));
viewportSelect.addEventListener("change", applyViewportSelection);
window.addEventListener("resize", () => {
	if (state) renderFrame(state.frameIndex);
});

loadButton.addEventListener("click", async () => {
	loadButton.disabled = true;
	sliderEl.disabled = true;
	try {
		await loadAndCompute();
	} catch (error) {
		console.error(error);
		loadingOverlay.classList.add("hidden");
		setStatus(`Load failed: ${error.message}`, "status-warn");
	} finally {
		loadButton.disabled = false;
	}
});

// Auto-load on page start
(async () => {
	loadButton.disabled = true;
	try {
		await loadAndCompute();
	} catch (error) {
		console.error(error);
		loadingOverlay.classList.add("hidden");
		setStatus(`Load failed: ${error.message}`, "status-warn");
	} finally {
		loadButton.disabled = false;
	}
})();