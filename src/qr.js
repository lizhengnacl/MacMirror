const DATA_CODEWORDS_LOW = [0, 19, 34, 55, 80];
const ECC_CODEWORDS_LOW = [0, 7, 10, 15, 20];
const BYTE_CAPACITY_LOW = [0, 17, 32, 53, 78];

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);

let gfValue = 1;
for (let i = 0; i < 255; i += 1) {
  GF_EXP[i] = gfValue;
  GF_LOG[gfValue] = i;
  gfValue <<= 1;
  if ((gfValue & 0x100) !== 0) {
    gfValue ^= 0x11d;
  }
}
for (let i = 255; i < GF_EXP.length; i += 1) {
  GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(left, right) {
  if (left === 0 || right === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[left] + GF_LOG[right]];
}

function reedSolomonDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;

  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMultiply(root, 0x02);
  }

  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);

  for (const value of data) {
    const factor = value ^ result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }

  return result;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push((value >>> i) & 1);
  }
}

function makeDataCodewords(text, version) {
  const bytes = new TextEncoder().encode(text);
  const capacityBits = DATA_CODEWORDS_LOW[version] * 8;
  const bits = [];

  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }

  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | bits[i + j];
    }
    codewords.push(value);
  }

  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < DATA_CODEWORDS_LOW[version]) {
    codewords.push(pads[padIndex % pads.length]);
    padIndex += 1;
  }

  return codewords;
}

function chooseVersion(text) {
  const length = new TextEncoder().encode(text).length;
  for (let version = 1; version <= 4; version += 1) {
    if (length <= BYTE_CAPACITY_LOW[version]) {
      return version;
    }
  }
  throw new Error("QR payload is too long for the built-in terminal encoder");
}

function makeMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(false));
}

function cloneMatrix(matrix) {
  return matrix.map((row) => row.slice());
}

function setFunctionModule(modules, reserved, x, y, dark) {
  if (x < 0 || y < 0 || y >= modules.length || x >= modules.length) {
    return;
  }
  modules[y][x] = dark;
  reserved[y][x] = true;
}

function reserveModule(reserved, x, y) {
  if (x < 0 || y < 0 || y >= reserved.length || x >= reserved.length) {
    return;
  }
  reserved[y][x] = true;
}

function drawFinder(modules, reserved, left, top) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const xx = left + x;
      const yy = top + y;
      if (xx < 0 || yy < 0 || yy >= modules.length || xx >= modules.length) {
        continue;
      }

      const inside = x >= 0 && x <= 6 && y >= 0 && y <= 6;
      const dark = inside && (
        x === 0 || x === 6 || y === 0 || y === 6 ||
        (x >= 2 && x <= 4 && y >= 2 && y <= 4)
      );
      setFunctionModule(modules, reserved, xx, yy, dark);
    }
  }
}

function drawAlignment(modules, reserved, centerX, centerY) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunctionModule(modules, reserved, centerX + x, centerY + y, distance !== 1);
    }
  }
}

function drawFunctionPatterns(modules, reserved, version) {
  const size = modules.length;

  drawFinder(modules, reserved, 0, 0);
  drawFinder(modules, reserved, size - 7, 0);
  drawFinder(modules, reserved, 0, size - 7);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunctionModule(modules, reserved, i, 6, dark);
    setFunctionModule(modules, reserved, 6, i, dark);
  }

  if (version >= 2) {
    drawAlignment(modules, reserved, size - 7, size - 7);
  }

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      reserveModule(reserved, 8, i);
      reserveModule(reserved, i, 8);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    reserveModule(reserved, size - 1 - i, 8);
    reserveModule(reserved, 8, size - 1 - i);
  }
  reserveModule(reserved, 8, size - 8);
}

function getFormatBits(mask) {
  const errorCorrectionLow = 1;
  let data = (errorCorrectionLow << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder <<= 1;
    if (((remainder >>> 10) & 1) !== 0) {
      remainder ^= 0x537;
    }
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function drawFormatBits(modules, reserved, mask) {
  const size = modules.length;
  const bits = getFormatBits(mask);

  for (let i = 0; i <= 5; i += 1) {
    setFunctionModule(modules, reserved, 8, i, getBit(bits, i));
  }
  setFunctionModule(modules, reserved, 8, 7, getBit(bits, 6));
  setFunctionModule(modules, reserved, 8, 8, getBit(bits, 7));
  setFunctionModule(modules, reserved, 7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) {
    setFunctionModule(modules, reserved, 14 - i, 8, getBit(bits, i));
  }

  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(modules, reserved, size - 1 - i, 8, getBit(bits, i));
  }
  for (let i = 8; i < 15; i += 1) {
    setFunctionModule(modules, reserved, 8, size - 15 + i, getBit(bits, i));
  }

  setFunctionModule(modules, reserved, 8, size - 8, true);
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function drawCodewords(modules, reserved, codewords) {
  const bits = [];
  for (const codeword of codewords) {
    appendBits(bits, codeword, 8);
  }

  const size = modules.length;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1;
    }

    for (let rowOffset = 0; rowOffset < size; rowOffset += 1) {
      const y = upward ? size - 1 - rowOffset : rowOffset;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (reserved[y][x]) {
          continue;
        }
        if (bitIndex < bits.length) {
          modules[y][x] = bits[bitIndex] === 1;
          bitIndex += 1;
        }
      }
    }

    upward = !upward;
  }
}

function applyMask(modules, reserved, mask) {
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (!reserved[y][x] && maskBit(mask, x, y)) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

function penaltyScore(modules) {
  const size = modules.length;
  let penalty = 0;

  for (let y = 0; y < size; y += 1) {
    let runColor = modules[y][0];
    let runLength = 1;
    for (let x = 1; x < size; x += 1) {
      if (modules[y][x] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) {
          penalty += runLength - 2;
        }
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    if (runLength >= 5) {
      penalty += runLength - 2;
    }
  }

  for (let x = 0; x < size; x += 1) {
    let runColor = modules[0][x];
    let runLength = 1;
    for (let y = 1; y < size; y += 1) {
      if (modules[y][x] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) {
          penalty += runLength - 2;
        }
        runColor = modules[y][x];
        runLength = 1;
      }
    }
    if (runLength >= 5) {
      penalty += runLength - 2;
    }
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (
        modules[y][x + 1] === color &&
        modules[y + 1][x] === color &&
        modules[y + 1][x + 1] === color
      ) {
        penalty += 3;
      }
    }
  }

  let dark = 0;
  for (const row of modules) {
    for (const value of row) {
      if (value) {
        dark += 1;
      }
    }
  }
  const ratio = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return penalty;
}

export function makeQrMatrix(text) {
  const version = chooseVersion(text);
  const size = version * 4 + 17;
  const baseModules = makeMatrix(size);
  const baseReserved = makeMatrix(size);

  drawFunctionPatterns(baseModules, baseReserved, version);

  const data = makeDataCodewords(text, version);
  const divisor = reedSolomonDivisor(ECC_CODEWORDS_LOW[version]);
  const ecc = reedSolomonRemainder(data, divisor);
  const codewords = data.concat(ecc);

  drawCodewords(baseModules, baseReserved, codewords);

  let bestModules = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = cloneMatrix(baseModules);
    const reserved = cloneMatrix(baseReserved);
    applyMask(modules, reserved, mask);
    drawFormatBits(modules, reserved, mask);
    const score = penaltyScore(modules);
    if (score < bestPenalty) {
      bestPenalty = score;
      bestModules = modules;
    }
  }

  return bestModules;
}

export function renderQrTerminal(text) {
  const modules = makeQrMatrix(text);
  const quiet = 4;
  const size = modules.length + quiet * 2;
  const rows = [];

  for (let y = 0; y < size; y += 1) {
    let row = "";
    for (let x = 0; x < size; x += 1) {
      const moduleY = y - quiet;
      const moduleX = x - quiet;
      const dark = moduleY >= 0 &&
        moduleX >= 0 &&
        moduleY < modules.length &&
        moduleX < modules.length &&
        modules[moduleY][moduleX];
      row += dark ? "##" : "  ";
    }
    rows.push(row);
  }

  return rows.join("\n");
}

export function renderQrSvg(text, moduleSize = 8) {
  const modules = makeQrMatrix(text);
  const quiet = 4;
  const size = (modules.length + quiet * 2) * moduleSize;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
    `<rect width="100%" height="100%" fill="#fff"/>`
  ];

  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (modules[y][x]) {
        parts.push(`<rect x="${(x + quiet) * moduleSize}" y="${(y + quiet) * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="#000"/>`);
      }
    }
  }

  parts.push("</svg>");
  return parts.join("");
}
