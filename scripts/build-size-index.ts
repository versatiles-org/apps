import { Container } from '@versatiles/container';
import type { Block } from '@versatiles/container';
import { writeFileSync, mkdirSync } from 'node:fs';

// --- Types ---

type QuadNode = number | [QuadNode, QuadNode, QuadNode, QuadNode];

interface Stats {
	tileCount: number;
	sum: number;
	sumOfSquares: number;
}

interface BlockData {
	block: Block;
	lengths: Float64Array;
}

interface BuildResult {
	node: QuadNode;
	stats: Stats;
}

// --- Configuration ---

const MIN_NODE_SIZE = 16;
const CV_THRESHOLD = 0.5; // Coefficient of variation threshold for collapsing to mean
const CONCURRENCY = 4; // Number of concurrent tile index fetches
const MAX_ATTEMPTS = 5; // Attempts per HTTP request before giving up
const RETRY_DELAY = 2000; // Delay before the first retry, doubled on each further attempt

// --- Main ---

async function main(url: string, outputPath: string): Promise<void> {
	console.log(`Building ${outputPath} from ${url}`);
	const container = new Container(url);
	const header = await withRetry('header', () => container.getHeader());

	const blockIndex = await withRetry('block index', () => container.getBlockIndex());

	// Group blocks by zoom level and count total
	const blocksByZoom = new Map<number, Block[]>();
	let totalBlocks = 0;
	for (let z = header.zoomMin; z <= header.zoomMax; z++) {
		const blocks: Block[] = [];
		for (const block of blockIndex.values()) {
			if (block.level === z) blocks.push(block);
		}
		blocksByZoom.set(z, blocks);
		totalBlocks += blocks.length;
	}

	let completedBlocks = 0;
	const levels: Record<string, QuadNode> = {};

	for (let z = header.zoomMin; z <= header.zoomMax; z++) {
		const blocks = blocksByZoom.get(z)!;

		if (blocks.length === 0) {
			levels[z] = 0;
			continue;
		}

		const blockDataMap = await fetchAllTileIndices(container, blocks, () => {
			completedBlocks++;
			if (completedBlocks % 100 === 0 || completedBlocks === totalBlocks) {
				const pct = ((completedBlocks / totalBlocks) * 100).toFixed(1);
				process.stdout.write(
					`\r  Fetching tile indices: ${completedBlocks}/${totalBlocks} (${pct}%)`
				);
			}
		});

		const gridSize = 1 << z;
		levels[z] = buildNode(blockDataMap, 0, 0, gridSize).node;
	}

	process.stdout.write('\n');
	const json = JSON.stringify({ levels });
	writeFileSync(outputPath, json);
	console.log(`  Written ${formatBytes(json.length)} to ${outputPath}`);
}

// --- Fetch tile indices with concurrency limit ---

async function fetchAllTileIndices(
	container: Container,
	blocks: Block[],
	onProgress: () => void
): Promise<Map<string, BlockData>> {
	const map = new Map<string, BlockData>();
	let completed = 0;
	let running = 0;
	let idx = 0;

	await new Promise<void>((resolve, reject) => {
		function next(): void {
			while (running < CONCURRENCY && idx < blocks.length) {
				const block = blocks[idx++];
				running++;
				withRetry(`tile index ${block.level}/${block.column}/${block.row}`, () =>
					container.getTileIndex(block)
				)
					.then((tileIndex) => {
						const key = `${block.column},${block.row}`;
						map.set(key, { block, lengths: tileIndex.lengths });
						running--;
						completed++;
						onProgress();
						if (completed === blocks.length) {
							resolve();
						} else {
							next();
						}
					})
					.catch(reject);
			}
		}
		if (blocks.length === 0) resolve();
		else next();
	});

	return map;
}

// --- Quadtree builder ---

function buildNode(
	blockDataMap: Map<string, BlockData>,
	xMin: number,
	yMin: number,
	size: number
): BuildResult {
	if (size <= MIN_NODE_SIZE) {
		// Leaf: compute stats directly
		const stats = collectStats(blockDataMap, xMin, yMin, size);
		const mean = stats.tileCount === 0 ? 0 : stats.sum / (size * size);
		return { node: Math.round(mean), stats };
	}

	// Branch: recurse into 4 children
	const half = size / 2;
	const nw = buildNode(blockDataMap, xMin, yMin, half);
	const ne = buildNode(blockDataMap, xMin + half, yMin, half);
	const sw = buildNode(blockDataMap, xMin, yMin + half, half);
	const se = buildNode(blockDataMap, xMin + half, yMin + half, half);

	// Merge child stats
	const mergedStats: Stats = {
		tileCount: nw.stats.tileCount + ne.stats.tileCount + sw.stats.tileCount + se.stats.tileCount,
		sum: nw.stats.sum + ne.stats.sum + sw.stats.sum + se.stats.sum,
		sumOfSquares:
			nw.stats.sumOfSquares + ne.stats.sumOfSquares + sw.stats.sumOfSquares + se.stats.sumOfSquares
	};

	// If no tiles at all, collapse to 0
	if (mergedStats.tileCount === 0) {
		return { node: 0, stats: mergedStats };
	}

	// Compute coefficient of variation of non-zero tile sizes
	const mean = mergedStats.sum / mergedStats.tileCount;
	const variance = mergedStats.sumOfSquares / mergedStats.tileCount - mean * mean;
	const stddev = Math.sqrt(Math.max(0, variance));
	const cv = mean > 0 ? stddev / mean : 0;

	const totalMean = mergedStats.sum / (size * size);

	if (cv < CV_THRESHOLD) {
		return { node: Math.round(totalMean), stats: mergedStats };
	}

	// Optimization: if all 4 children are identical leaves, collapse
	if (
		typeof nw.node === 'number' &&
		typeof ne.node === 'number' &&
		typeof sw.node === 'number' &&
		typeof se.node === 'number' &&
		nw.node === ne.node &&
		nw.node === sw.node &&
		nw.node === se.node
	) {
		return { node: nw.node, stats: mergedStats };
	}

	return { node: [nw.node, ne.node, sw.node, se.node], stats: mergedStats };
}

// --- Collect stats from tile data ---

function collectStats(
	blockDataMap: Map<string, BlockData>,
	xMin: number,
	yMin: number,
	size: number
): Stats {
	const xMax = xMin + size;
	const yMax = yMin + size;

	// Determine overlapping block range
	const bxMin = xMin >> 8;
	const bxMax = (xMax - 1) >> 8;
	const byMin = yMin >> 8;
	const byMax = (yMax - 1) >> 8;

	let tileCount = 0;
	let sum = 0;
	let sumOfSquares = 0;

	for (let bx = bxMin; bx <= bxMax; bx++) {
		for (let by = byMin; by <= byMax; by++) {
			const key = `${bx},${by}`;
			const data = blockDataMap.get(key);
			if (!data) continue;

			const { block, lengths } = data;

			// Compute tile intersection with query rect
			const tileXMin = Math.max(xMin - bx * 256, block.colMin);
			const tileXMax = Math.min(xMax - 1 - bx * 256, block.colMax);
			const tileYMin = Math.max(yMin - by * 256, block.rowMin);
			const tileYMax = Math.min(yMax - 1 - by * 256, block.rowMax);

			if (tileXMin > tileXMax || tileYMin > tileYMax) continue;

			const cols = block.colMax - block.colMin + 1;

			for (let ty = tileYMin; ty <= tileYMax; ty++) {
				for (let tx = tileXMin; tx <= tileXMax; tx++) {
					const j = (ty - block.rowMin) * cols + (tx - block.colMin);
					const len = lengths[j];
					if (len > 0) {
						tileCount++;
						sum += len;
						sumOfSquares += len * len;
					}
				}
			}
		}
	}

	return { tileCount, sum, sumOfSquares };
}

// --- Utilities ---

/**
 * Retries a failed request with exponential backoff.
 *
 * A full build issues tens of thousands of HTTP range requests, so an occasional
 * stalled or reset connection is normal. The container's HTTP reader aborts a
 * request after 10s of idle time; without retries a single such stall throws an
 * unhandled rejection and discards the whole ~20 minute build.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS) throw error;
			const delay = RETRY_DELAY * 2 ** (attempt - 1);
			const message = error instanceof Error ? error.message : String(error);
			// Leading newline: the progress line is written without one.
			process.stdout.write(
				`\n  Fetching ${what} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${message}` +
					` — retrying in ${delay / 1000}s\n`
			);
			await sleep(delay);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const sources = [
	{
		url: 'https://download.versatiles.org/osm.versatiles',
		output: 'static/data/size-index-osm.json'
	},
	{
		url: 'https://download.versatiles.org/satellite.versatiles',
		output: 'static/data/size-index-satellite.json'
	},
	{
		url: 'https://download.versatiles.org/elevation.versatiles',
		output: 'static/data/size-index-elevation.json'
	}
];

mkdirSync('static/data', { recursive: true });

for (const { url, output } of sources) {
	await main(url, output);
}
