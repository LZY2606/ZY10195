export type Matrix = number[][];

export const zeros = (rows: number, cols: number = rows): Matrix =>
  Array.from({ length: rows }, () => Array<number>(cols).fill(0));

export function transpose(a: Matrix): Matrix {
  return Array.from({ length: a[0]?.length ?? 0 }, (_, i) => a.map((row) => row[i]));
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const rows = a.length;
  const inner = b.length;
  const cols = b[0]?.length ?? 0;
  const result = zeros(rows, cols);
  for (let i = 0; i < rows; i += 1) {
    for (let k = 0; k < inner; k += 1) {
      const aik = a[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < cols; j += 1) result[i][j] += aik * b[k][j];
    }
  }
  return result;
}

export function matVec(a: Matrix, x: number[]): number[] {
  return a.map((row) => row.reduce((sum, value, i) => sum + value * x[i], 0));
}

export function symmetricEigen(a: Matrix): { values: number[]; vectors: Matrix } {
  const n = a.length;
  const values = a.map((row, i) => row[i]);
  const vectors = zeros(n);
  for (let i = 0; i < n; i++) vectors[i][i] = 1;
  const matrix = a.map((row) => [...row]);

  for (let sweep = 0; sweep < 100; sweep += 1) {
    let offDiagonal = 0;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) offDiagonal += matrix[p][q] * matrix[p][q];
    }
    if (offDiagonal < 1e-24) break;

    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(matrix[p][q]) < 1e-15) continue;
        const tau = (values[q] - values[p]) / (2 * matrix[p][q]);
        const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;

        for (let k = 0; k < n; k += 1) {
          if (k === p || k === q) continue;
          const apk = matrix[p][k];
          const aqk = matrix[q][k];
          matrix[p][k] = c * apk - s * aqk;
          matrix[k][p] = matrix[p][k];
          matrix[q][k] = s * apk + c * aqk;
          matrix[k][q] = matrix[q][k];
        }

        const app = values[p];
        const aqq = values[q];
        const apq = matrix[p][q];
        values[p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        values[q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        matrix[p][q] = 0;
        matrix[q][p] = 0;

        for (let k = 0; k < n; k += 1) {
          const vkp = vectors[k][p];
          const vkq = vectors[k][q];
          vectors[k][p] = c * vkp - s * vkq;
          vectors[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = values.map((_, i) => i).sort((i, j) => values[i] - values[j]);
  return {
    values: order.map((i) => values[i]),
    vectors: vectors.map((row) => order.map((i) => row[i])),
  };
}

export function pseudoInverseNormal(normal: Matrix, tolerance = 1e-9): { inverse: Matrix; rank: number; values: number[]; vectors: Matrix } {
  const { values, vectors } = symmetricEigen(normal);
  const scale = Math.max(...values.map((value) => Math.abs(value)), Number.EPSILON);
  const threshold = tolerance * scale;
  const rank = values.filter((value) => value > threshold).length;
  const inverse = zeros(normal.length);
  for (let k = 0; k < normal.length; k += 1) {
    if (values[k] <= threshold) continue;
    const column = vectors.map((row) => row[k]);
    for (let i = 0; i < normal.length; i += 1) {
      for (let j = 0; j < normal.length; j += 1) inverse[i][j] += (column[i] * column[j]) / values[k];
    }
  }
  return { inverse, rank, values, vectors };
}

export const eigen3 = symmetricEigen;
