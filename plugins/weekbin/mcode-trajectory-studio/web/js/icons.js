/**
 * Inline SVG icons.
 *
 * Icons are built once per (name, class) pair and cloned; rebuilding ~120 SVGs per
 * sidebar render was measurable.
 */

const ICONS = {
  folder: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5a1 1 0 0 1 .8.4l.8 1.1h4.7A1.6 1.6 0 0 1 14 6.1v5.3A1.6 1.6 0 0 1 12.4 13H3.6A1.6 1.6 0 0 1 2 11.4z',
  caretRight: 'M6.5 3.8 10.2 8l-3.7 4.2',
  caretDown: 'M3.8 6.5 8 10.2l4.2-3.7',
};

const ICON_TEMPLATES = new Map();

export function icon(name, className = 'ic') {
  const key = `${name}|${className}`;
  let template = ICON_TEMPLATES.get(key);
  if (!template) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name] ?? '');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    template = svg;
    ICON_TEMPLATES.set(key, template);
  }
  return template.cloneNode(true);
}
