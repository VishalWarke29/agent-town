import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three';

// Original, code-drawn art. No downloaded game assets or external requests.
export function characterTexture(coat: string, direction: number, frame: number, manager = false) {
  const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 28;
  const ctx = canvas.getContext('2d')!;
  const rect = (x: number, y: number, w: number, h: number, color: string) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  const step = frame === 1 ? 1 : frame === 2 ? -1 : 0;
  rect(5, 22 + step, 4, 4 - step, '#384349'); rect(11, 22 - step, 4, 4 + step, '#384349');
  rect(4, 25 + step, 5, 2, '#25333b'); rect(11, 25 - step, 5, 2, '#25333b');
  rect(5, 13, 10, 10, '#453a36'); rect(4, 14, 12, 8, coat);
  rect(3, 16, 2, 6, coat); rect(15, 16, 2, 6, coat);
  rect(3, 21, 2, 2, '#d5a67d'); rect(15, 21, 2, 2, '#d5a67d');
  rect(9, 14, 2, 7, '#f5e4bd'); rect(5, 21, 10, 2, coat);
  rect(6, 3, 9, 10, '#533b34'); rect(5, 6, 11, 6, '#533b34');
  rect(6, 6, 9, 7, '#e6b78e'); rect(5, 8, 1, 3, '#c68e6b');
  rect(6, 3, 9, 4, manager ? '#b8b5a6' : '#533b34'); rect(5, 5, 3, 4, manager ? '#b8b5a6' : '#533b34');
  if (direction === 0) {
    rect(6, 6, 9, 7, manager ? '#b8b5a6' : '#533b34'); rect(6, 11, 9, 2, '#d3a580');
    rect(7, 15, 6, 7, '#6b6555'); rect(8, 16, 4, 4, '#b7a785');
  } else {
    const dx = direction === 1 ? 2 : direction === 3 ? -1 : 0;
    rect(8 + dx, 8, 1, 2, '#293535'); rect(12 + dx, 8, 1, 2, '#293535');
    rect(10 + dx, 11, 2, 1, '#aa7158');
    if (manager) { rect(7 + dx, 8, 3, 1, '#59625c'); rect(11 + dx, 8, 3, 1, '#59625c'); }
  }
  if (!manager) { rect(6, 2, 9, 3, coat); rect(5, 4, 12, 2, coat); rect(11, 3, 2, 1, '#efdab0'); }
  const texture = new CanvasTexture(canvas); texture.magFilter = NearestFilter; texture.minFilter = NearestFilter; texture.colorSpace = SRGBColorSpace;
  return texture;
}
