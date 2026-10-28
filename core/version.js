// Strict SemVer precedence; build metadata does not affect precedence.
export function compareVersions(left, right) {
  const parse = value => String(value).trim().replace(/^v/, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  const a = parse(left), b = parse(right);
  if (!a || !b) throw new Error(`无法比较非标准版本：${left} / ${right}`);
  if ([a, b].some(v => v[4]?.split('.').some(id => /^0\d+$/.test(id)))) throw new Error('预发布版本数字不能含前导零');
  for (let i = 1; i <= 3; i++) {
    if (BigInt(a[i]) !== BigInt(b[i])) return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn) return BigInt(x[i]) > BigInt(y[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

export function compareCachedVersions(left, right) {
  try { return compareVersions(left, right); }
  catch { return String(left).localeCompare(String(right), 'en', { numeric: true }); }
}
