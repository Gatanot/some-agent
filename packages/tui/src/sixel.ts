import { inflateSync } from "node:zlib";

/**
 * Minimal sixel encoder for inline terminal images.
 *
 * Supports the DEC sixel graphics protocol (DEC STD 070) as implemented by
 * Windows Terminal 1.22+ and xterm-compatible terminals. The encoder decodes
 * PNG data without dependencies, scales it to the requested pixel size with
 * box averaging, quantizes colors per image (adaptive palette, max 256
 * entries), and emits the sixel band stream with run-length compression.
 */

export interface RgbaImage {
	width: number;
	height: number;
	pixels: Uint8Array; // RGBA, 4 bytes per pixel
}

export interface SixelImage {
	/** Full sixel sequence, including introducer and finalizer. */
	data: string;
	widthPx: number;
	heightPx: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

/**
 * Decode an 8-bit, non-interlaced PNG into straight RGBA pixels.
 * Supports color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha) and 6
 * (RGBA). Returns null for unsupported encodings.
 */
export function decodePngToRgba(bytes: Uint8Array): RgbaImage | null {
	if (bytes.length < 8 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
		return null;
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: number[] = [];
	const idat: Uint8Array[] = [];

	while (offset + 8 <= bytes.length) {
		const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
		const data = bytes.subarray(offset + 8, offset + 8 + length);

		if (type === "IHDR" && length >= 13) {
			width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
			height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
			bitDepth = data[8];
			colorType = data[9];
			interlace = data[12];
		} else if (type === "PLTE") {
			palette = [...data];
		} else if (type === "IDAT") {
			idat.push(data);
		} else if (type === "IEND") {
			break;
		}

		offset += 12 + length;
	}

	if (!width || !height || bitDepth !== 8 || interlace !== 0 || idat.length === 0) {
		return null;
	}

	// channels: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA
	const channels =
		colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
	if (channels === 0 || (colorType === 3 && palette.length === 0)) {
		return null;
	}

	let raw: Uint8Array;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return null;
	}

	const stride = width * channels;
	const expected = (stride + 1) * height;
	if (raw.length < expected) {
		return null;
	}

	const pixels = new Uint8Array(width * height * 4);
	let previous = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		if (filter > 4) {
			return null;
		}
		const current = new Uint8Array(stride);
		const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? current[x - channels] : 0;
			const up = previous[x];
			const upLeft = x >= channels ? previous[x - channels] : 0;
			let value = row[x];
			switch (filter) {
				case 0:
					break;
				case 1:
					value = (value + left) & 0xff;
					break;
				case 2:
					value = (value + up) & 0xff;
					break;
				case 3:
					value = (value + ((left + up) >> 1)) & 0xff;
					break;
				case 4:
					value = (value + paeth(left, up, upLeft)) & 0xff;
					break;
			}
			current[x] = value;
		}
		for (let x = 0; x < width; x++) {
			const source = x * channels;
			const target = (y * width + x) * 4;
			switch (colorType) {
				case 0: {
					const gray = current[source];
					pixels[target] = gray;
					pixels[target + 1] = gray;
					pixels[target + 2] = gray;
					pixels[target + 3] = 255;
					break;
				}
				case 2:
					pixels[target] = current[source];
					pixels[target + 1] = current[source + 1];
					pixels[target + 2] = current[source + 2];
					pixels[target + 3] = 255;
					break;
				case 3: {
					const paletteIndex = current[source] * 3;
					if (paletteIndex + 2 >= palette.length) return null;
					pixels[target] = palette[paletteIndex];
					pixels[target + 1] = palette[paletteIndex + 1];
					pixels[target + 2] = palette[paletteIndex + 2];
					pixels[target + 3] = 255;
					break;
				}
				case 4: {
					const gray = current[source];
					pixels[target] = gray;
					pixels[target + 1] = gray;
					pixels[target + 2] = gray;
					pixels[target + 3] = current[source + 1];
					break;
				}
				case 6:
					pixels[target] = current[source];
					pixels[target + 1] = current[source + 1];
					pixels[target + 2] = current[source + 2];
					pixels[target + 3] = current[source + 3];
					break;
			}
		}
		previous = current;
	}

	return { width, height, pixels };
}

/**
 * Scale RGBA pixels with box averaging (downscale, area-weighted) or nearest
 * neighbor (upscale). Box averaging avoids moiré when shrinking line art.
 */
export function scaleRgba(
	src: Uint8Array,
	srcWidth: number,
	srcHeight: number,
	dstWidth: number,
	dstHeight: number,
): Uint8Array {
	if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
		return new Uint8Array(0);
	}
	if (srcWidth === dstWidth && srcHeight === dstHeight) {
		return src.slice();
	}

	const dst = new Uint8Array(dstWidth * dstHeight * 4);
	if (dstWidth > srcWidth || dstHeight > srcHeight) {
		// Nearest neighbor upscale.
		for (let y = 0; y < dstHeight; y++) {
			const srcY = Math.min(srcHeight - 1, Math.floor((y * srcHeight) / dstHeight));
			for (let x = 0; x < dstWidth; x++) {
				const srcX = Math.min(srcWidth - 1, Math.floor((x * srcWidth) / dstWidth));
				const srcIndex = (srcY * srcWidth + srcX) * 4;
				const dstIndex = (y * dstWidth + x) * 4;
				dst[dstIndex] = src[srcIndex];
				dst[dstIndex + 1] = src[srcIndex + 1];
				dst[dstIndex + 2] = src[srcIndex + 2];
				dst[dstIndex + 3] = src[srcIndex + 3];
			}
		}
		return dst;
	}

	for (let y = 0; y < dstHeight; y++) {
		const y0 = Math.floor((y * srcHeight) / dstHeight);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcHeight) / dstHeight));
		for (let x = 0; x < dstWidth; x++) {
			const x0 = Math.floor((x * srcWidth) / dstWidth);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcWidth) / dstWidth));
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let count = 0;
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const index = (sy * srcWidth + sx) * 4;
					r += src[index];
					g += src[index + 1];
					b += src[index + 2];
					a += src[index + 3];
					count++;
				}
			}
			const dstIndex = (y * dstWidth + x) * 4;
			dst[dstIndex] = Math.round(r / count);
			dst[dstIndex + 1] = Math.round(g / count);
			dst[dstIndex + 2] = Math.round(b / count);
			dst[dstIndex + 3] = Math.round(a / count);
		}
	}
	return dst;
}

const SIXEL_INTRODUCER = "\x1bP0;0;q";
const SIXEL_FINALIZER = "\x1b\\";
const SIXEL_CHAR_BASE = 63; // '?' = no pixels
const MAX_PALETTE_SIZE = 256;

interface PaletteEntry {
	red: number;
	green: number;
	blue: number;
}

/**
 * Build an adaptive palette (max 256 colors) for an RGBA image.
 * Aligned to uints so `indices` holds palette index + 1 (0 = transparent).
 */
function buildPalette(pixels: Uint8Array, count: number): { entries: PaletteEntry[]; indices: Uint8Array } | null {
	const counts = new Map<number, number>();
	const sums = new Map<number, [number, number, number]>();
	let unique = 0;

	for (let i = 0; i < count; i++) {
		const alpha = pixels[i * 4 + 3];
		if (alpha === 0) continue;
		const r = pixels[i * 4];
		const g = pixels[i * 4 + 1];
		const b = pixels[i * 4 + 2];
		const key = (r << 16) | (g << 8) | b;
		const previous = counts.get(key);
		if (previous === undefined) {
			counts.set(key, 1);
			sums.set(key, [r, g, b]);
			unique++;
		} else {
			counts.set(key, previous + 1);
			const sum = sums.get(key);
			if (sum) {
				sum[0] += r;
				sum[1] += g;
				sum[2] += b;
			}
		}
	}

	if (unique === 0) {
		return null;
	}

	const indices = new Uint8Array(count);
	if (unique <= MAX_PALETTE_SIZE) {
		const entries: PaletteEntry[] = [];
		const keyToIndex = new Map<number, number>();
		const keyOrder = [...counts.keys()].sort((a, b) => counts.get(a)! - counts.get(b)!);
		for (const key of keyOrder) {
			const sum = sums.get(key)!;
			keyToIndex.set(key, entries.length);
			entries.push({
				red: Math.round(sum[0] / counts.get(key)!),
				green: Math.round(sum[1] / counts.get(key)!),
				blue: Math.round(sum[2] / counts.get(key)!),
			});
		}
		for (let i = 0; i < count; i++) {
			if (pixels[i * 4 + 3] === 0) continue;
			const r = pixels[i * 4];
			const g = pixels[i * 4 + 1];
			const b = pixels[i * 4 + 2];
			indices[i] = keyToIndex.get((r << 16) | (g << 8) | b)! + 1;
		}
		return { entries, indices };
	}

	// More than 256 unique colors: quantize to 5 bits per channel and keep the
	// most frequent buckets, using the bucket average color as palette entry.
	const bucketCounts = new Map<number, number>();
	const bucketSums = new Map<number, [number, number, number]>();
	const qkey = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
	for (let i = 0; i < count; i++) {
		if (pixels[i * 4 + 3] === 0) continue;
		const key = qkey(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
		const previous = bucketCounts.get(key);
		if (previous === undefined) {
			bucketCounts.set(key, 1);
			bucketSums.set(key, [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]);
		} else {
			bucketCounts.set(key, previous + 1);
			const sum = bucketSums.get(key);
			if (sum) {
				sum[0] += pixels[i * 4];
				sum[1] += pixels[i * 4 + 1];
				sum[2] += pixels[i * 4 + 2];
			}
		}
	}

	const top = [...bucketCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_PALETTE_SIZE);
	const bucketToIndex = new Map<number, number>();
	const entries: PaletteEntry[] = [];
	for (const [key] of top) {
		const sum = bucketSums.get(key)!;
		bucketToIndex.set(key, entries.length);
		entries.push({
			red: Math.round(sum[0] / bucketCounts.get(key)!),
			green: Math.round(sum[1] / bucketCounts.get(key)!),
			blue: Math.round(sum[2] / bucketCounts.get(key)!),
		});
	}

	const nearestCache = new Map<number, number>();
	const nearestIndex = (key: number): number => {
		const cached = nearestCache.get(key);
		if (cached !== undefined) return cached;
		const r = (key >> 10) << 3;
		const g = ((key >> 5) & 0x1f) << 3;
		const b = (key & 0x1f) << 3;
		let best = 0;
		let bestDistance = Number.MAX_SAFE_INTEGER;
		for (let i = 0; i < entries.length; i++) {
			const dr = entries[i].red - r;
			const dg = entries[i].green - g;
			const db = entries[i].blue - b;
			const distance = dr * dr + dg * dg + db * db;
			if (distance < bestDistance) {
				bestDistance = distance;
				best = i;
			}
		}
		nearestCache.set(key, best);
		return best;
	};

	for (let i = 0; i < count; i++) {
		if (pixels[i * 4 + 3] === 0) continue;
		const key = qkey(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]);
		indices[i] = (bucketToIndex.get(key) ?? nearestIndex(key)) + 1;
	}
	return { entries, indices };
}

function codeToSixel(mask: number, repeat: number): string {
	const char = String.fromCharCode(SIXEL_CHAR_BASE + mask);
	if (repeat > 3) return `!${repeat}${char}`;
	if (repeat === 3) return char + char + char;
	if (repeat === 2) return char + char;
	return char;
}

/** Encode one 6-row band with per-color runs and '?' gaps. */
function encodeBand(
	indices: Uint8Array,
	width: number,
	bandStart: number,
	bandRows: number,
	paletteSize: number,
): string {
	const last = new Int16Array(paletteSize + 1);
	last.fill(-1);
	const code = new Uint8Array(paletteSize + 1);
	const accu = new Uint32Array(paletteSize + 1);
	const slotOfIndex = new Int16Array(paletteSize + 1);
	slotOfIndex.fill(-1);
	const usedIndices: number[] = [];
	const slotRuns: number[][] = [];

	for (let column = 0; column < width; column++) {
		for (let i = 0; i < usedIndices.length; i++) {
			code[i] = 0;
		}
		for (let row = 0; row < bandRows; row++) {
			const index = indices[bandStart + row * width + column];
			if (index === 0) continue;
			let slot = slotOfIndex[index];
			if (slot === -1) {
				slot = usedIndices.length;
				slotOfIndex[index] = slot;
				usedIndices.push(index);
				slotRuns.push([]);
				if (column > 0) {
					last[slot] = 0;
					accu[slot] = column;
				}
			}
			code[slot] |= 1 << row;
		}
		for (let slot = 0; slot < usedIndices.length; slot++) {
			const slotCode = code[slot];
			if (slotCode === last[slot]) {
				accu[slot]++;
			} else {
				if (last[slot] !== -1) {
					slotRuns[slot].push(SIXEL_CHAR_BASE + last[slot], accu[slot]);
				}
				last[slot] = slotCode;
				accu[slot] = 1;
			}
		}
	}
	for (let slot = 0; slot < usedIndices.length; slot++) {
		if (last[slot] !== 0) {
			slotRuns[slot].push(SIXEL_CHAR_BASE + last[slot], accu[slot]);
		}
	}

	let out = "";
	for (let slot = 0; slot < usedIndices.length; slot++) {
		const index = usedIndices[slot];
		if (index === 0) continue;
		out += `#${index - 1}`;
		const runs = slotRuns[slot]!;
		for (let i = 0; i < runs.length; i += 2) {
			out += codeToSixel(runs[i]! - SIXEL_CHAR_BASE, runs[i + 1]!);
		}
		out += "$";
	}
	return out;
}

/**
 * Encode RGBA pixels as a sixel sequence. Fully transparent pixels are left
 * unpainted (the terminal shows its background there).
 */
export function encodeSixelRgba(pixels: Uint8Array, width: number, height: number): string {
	if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
		return "";
	}
	const palette = buildPalette(pixels, width * height);
	if (!palette) {
		return "";
	}

	let out = `${SIXEL_INTRODUCER}"1;1;${width};${height}`;
	for (let i = 0; i < palette.entries.length; i++) {
		const entry = palette.entries[i]!;
		out += `#${i};2;${Math.round((entry.red / 255) * 100)};${Math.round((entry.green / 255) * 100)};${Math.round((entry.blue / 255) * 100)}`;
	}

	const bands = Math.ceil(height / 6);
	for (let band = 0; band < bands; band++) {
		const bandStart = band * 6 * width;
		const bandRows = Math.min(6, height - band * 6);
		out += encodeBand(palette.indices, width, bandStart, bandRows, palette.entries.length);
		if (band < bands - 1) {
			out += "-";
		}
	}
	return out + SIXEL_FINALIZER;
}

/**
 * Decode a base64 PNG and encode it as sixel, scaled to fit within
 * `maxWidthPx` x `maxHeightPx`. Returns null when the PNG cannot be decoded.
 */
export function encodePngToSixel(base64Data: string, maxWidthPx: number, maxHeightPx: number): SixelImage | null {
	const decoded = decodePngToRgba(Buffer.from(base64Data, "base64"));
	if (!decoded) {
		return null;
	}
	const scale = Math.min(maxWidthPx / decoded.width, maxHeightPx / decoded.height);
	const width = Math.max(1, Math.round(decoded.width * scale));
	const height = Math.max(1, Math.round(decoded.height * scale));
	const scaled = scaleRgba(decoded.pixels, decoded.width, decoded.height, width, height);
	return { data: encodeSixelRgba(scaled, width, height), widthPx: width, heightPx: height };
}
