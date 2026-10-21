/**
 * The page's element builders. Text goes in through `textContent` only, and
 * SVG geometry through attributes, never markup: every string rendered comes
 * out of a file someone else wrote.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An SVG element with its attributes, numbers written as they are. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
  return node
}

export function muted(text: string): HTMLSpanElement {
  return el('span', 'mq-muted', text)
}

/** Text that is a number and should line up: mono, tabular figures. */
export function num(text: string, tooltip?: string): HTMLSpanElement {
  const span = el('span', 'mq-mono mq-num', text)
  if (tooltip !== undefined) span.title = tooltip
  return span
}
