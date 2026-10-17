// Renders resources/icon.png (128x128): a rounded tile with a coral usage gauge. No dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SS = 4; // supersampling per axis
const px = new Float64Array(SIZE * SIZE * 4);

const mix = (a, b, t) => a + (b - a) * t;
function roundedRect(x, y, r) {
	const dx = Math.max(Math.abs(x - 64) - (64 - r), 0);
	const dy = Math.max(Math.abs(y - 64) - (64 - r), 0);
	return Math.hypot(dx, dy) <= r;
}
function shade(x, y) {
	if (!roundedRect(x, y, 26)) return null;
	const t = (x + y) / 256;
	let color = [mix(38, 22, t), mix(30, 20, t), mix(44, 34, t)];
	const cx = 64, cy = 72, d = Math.hypot(x - cx, y - cy);
	const angle = Math.atan2(y - cy, x - cx); // -PI..PI, 0 = right, arc spans 135deg..405deg
	let a = angle < Math.PI / 2 ? angle + 2 * Math.PI : angle;
	const inArc = a >= 0.75 * Math.PI && a <= 2.25 * Math.PI;
	const frac = (a - 0.75 * Math.PI) / (1.5 * Math.PI);
	if (inArc && d >= 34 && d <= 44) {
		const filled = frac <= 0.68;
		color = filled ? [mix(217, 232, frac), mix(119, 162, frac), mix(87, 58, frac)] : [70, 62, 78];
	}
	// needle towards 68% of the arc
	const na = 0.75 * Math.PI + 0.68 * 1.5 * Math.PI;
	const nx = Math.cos(na), ny = Math.sin(na);
	const proj = (x - cx) * nx + (y - cy) * ny;
	const perp = Math.abs(-(x - cx) * ny + (y - cy) * nx);
	if (proj >= -2 && proj <= 30 && perp <= 3.2 - proj * 0.06) color = [245, 240, 235];
	if (d <= 7) color = [245, 240, 235];
	// base bars
	const bars = [[40, 18], [56, 28], [72, 22], [88, 34]];
	for (const [bx, h] of bars) if (x >= bx - 5 && x <= bx + 5 && y >= 110 - h * 0.35 && y <= 110) color = [164, 93, 227];
	return color;
}
for (let y = 0; y < SIZE; y++)
	for (let x = 0; x < SIZE; x++) {
		let r = 0, g = 0, b = 0, a = 0;
		for (let sy = 0; sy < SS; sy++)
			for (let sx = 0; sx < SS; sx++) {
				const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
				if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
			}
		const i = (y * SIZE + x) * 4;
		px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = (a / (SS * SS)) * 255;
	}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
	raw[y * (SIZE * 4 + 1)] = 0;
	for (let x = 0; x < SIZE * 4; x++) raw[y * (SIZE * 4 + 1) + 1 + x] = Math.round(px[y * SIZE * 4 + x]);
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc = buf => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
	return Buffer.concat([len, body, sum]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${png.length} bytes)`);
