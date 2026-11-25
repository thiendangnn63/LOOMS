const face = [
  ['###....', '.#######.', '.#######.', '###....###', '.########'],
  ['###....', '#########', '#########', '####..####', '#########'],
  ['###....', '###...###', '###...###', '##########', '###......'],
  ['###....', '###...###', '###...###', '###.##.###', '###......'],
  ['###....', '###...###', '###...###', '###.##.###', '.#######.'],
  ['###....', '###...###', '###...###', '###....###', '..#######'],
  ['###....', '###...###', '###...###', '###....###', '......###'],
  ['###....', '###...###', '###...###', '###....###', '......###'],
  ['#######', '#########', '#########', '###....###', '#########'],
  ['#######', '.#######.', '.#######.', '###....###', '########.'],
].map(row => row.join('..'));

export const logoWidth = face[0].length + 1;
const pixels = Array.from({ length: face.length + 1 }, (_, y) =>
  Array.from({ length: logoWidth }, (_, x) => {
    if (face[y]?.[x] === '#') return face[y - 1]?.[x] === '#' ? '198;199;210' : '235;235;242';
    if (face[y - 1]?.[x - 1] === '#') return '82;84;104';
    return undefined;
  }));

function renderLogo(styled) {
  const rows = [];
  // A half-block combines two pixel rows in one terminal cell.
  for (let y = 0; y < pixels.length; y += 2) {
    rows.push(pixels[y].map((top, x) => {
      const bottom = pixels[y + 1]?.[x];
      if (!top && !bottom) return ' ';
      const full = top && bottom && (top === bottom || !styled);
      const glyph = full ? '█' : top ? '▀' : '▄';
      if (!styled) return glyph;
      const background = !full && top && bottom ? `;48;2;${bottom}` : '';
      return `\x1b[38;2;${top ?? bottom}${background}m${glyph}\x1b[0m`;
    }).join(''));
  }
  return rows;
}

export const logoArt = { styled: renderLogo(true), plain: renderLogo(false) };
