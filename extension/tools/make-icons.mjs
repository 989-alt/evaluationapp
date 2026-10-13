// 확장 아이콘(16/48/128 PNG)을 만듭니다. 외부 의존성 없이 node:zlib만 씁니다.
// 실행: node extension/tools/make-icons.mjs
// 모양: 주황(#FF5A1F) 둥근 사각형 + 흰색 오른쪽 꺾쇠(→ 나이스로 보내기)
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')
const ACCENT = [0xff, 0x5a, 0x1f]
const WHITE = [0xff, 0xff, 0xff]

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// 단위 정사각형(0..1) 좌표에서 도형 안인지 판정
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}
function inChevron(x, y, w) {
  return distToSegment(x, y, 0.4, 0.27, 0.64, 0.5) <= w || distToSegment(x, y, 0.64, 0.5, 0.4, 0.73) <= w
}

function render(size) {
  const SS = 4 // 4x4 슈퍼샘플링
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const stroke = size <= 16 ? 0.085 : 0.07
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0 // filter: none
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size
          const y = (py + (sy + 0.5) / SS) / size
          if (inRoundRect(x, y, 0.22)) {
            if (inChevron(x, y, stroke)) fg++
            else bg++
          }
        }
      }
      const n = SS * SS
      const a = (bg + fg) / n
      const mix = bg + fg ? fg / (bg + fg) : 0
      const o = py * (size * 4 + 1) + 1 + px * 4
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(ACCENT[c] * (1 - mix) + WHITE[c] * mix)
      raw[o + 3] = Math.round(a * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
for (const s of [16, 48, 128]) {
  const png = render(s)
  writeFileSync(join(OUT, `icon${s}.png`), png)
  console.log(`icons/icon${s}.png ${png.length} bytes`)
}
