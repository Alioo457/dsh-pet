/**
 * 面板落点几何：决定级联子菜单摆在父面板的哪一侧，保证不与任何已展开面板重叠。
 * 纯函数，不碰 DOM；调用方只负责读矩形与写样式。
 * @module dsh-pet/src/shared/menu/position
 */

/** 面板矩形（只需定位用到的边）。 */
export interface PanelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** {@link pickPanelPosition} 的入参。 */
export interface PanelPositionInput {
  /** 待摆放面板的尺寸。 */
  panel: { w: number; h: number };
  /** 触发它的菜单项。 */
  item: { left: number; right: number; top: number; bottom?: number };
  /** 它所属的那一层面板：子面板平级挂载，只有 DOM 父节点能给出正确的层。 */
  parent: { left: number; right: number; top: number };
  /** 其它已展开面板的矩形：新面板不得与其中任何一个相交。 */
  others: PanelBox[];
  /** 允许显示的范围（窗口 ∩ 工作区，视口坐标）。 */
  clamp: { x: number; y: number; w: number; h: number };
}

/** 面板与边界、面板之间的间距（px）。 */
const PANEL_GAP = 4;
type PanelPosition = { left: number; top: number };

/**
 * 决定子面板的落点：优先不与任何已展开面板重叠，其次贴边。
 *
 * @param input - 面板尺寸、触发项/父面板矩形、其它面板矩形与 clamp 范围。
 * @returns 面板左上角在视口坐标里的落点。
 */
export function pickPanelPosition(input: PanelPositionInput): PanelPosition;
export function pickPanelPosition(input: PanelPositionInput, allowOverlap: false): PanelPosition | null;
export function pickPanelPosition(input: PanelPositionInput, allowOverlap = true): PanelPosition | null {
  const { panel, item, parent, others, clamp } = input;
  const minLeft = clamp.x + PANEL_GAP;
  const minTop = clamp.y + PANEL_GAP;
  const maxLeft = clamp.x + clamp.w - PANEL_GAP - panel.w;
  const maxTop = clamp.y + clamp.h - PANEL_GAP - panel.h;
  /** 夹进 clamp；面板比 clamp 还宽/高时贴左上角。 */
  const clampX = (v: number): number => Math.max(minLeft, Math.min(v, Math.max(minLeft, maxLeft)));
  const clampY = (v: number): number => Math.max(minTop, Math.min(v, Math.max(minTop, maxTop)));
  const hitsOther = (left: number, top: number): boolean =>
    others.some((b) => left < b.right && left + panel.w > b.left && top < b.bottom && top + panel.h > b.top);
  const fitsClamp = (left: number, top: number): boolean =>
    left >= minLeft - 0.5 && left <= maxLeft + 0.5 && top >= minTop - 0.5 && top <= maxTop + 0.5;
  const reachable = (left: number, top: number): boolean =>
    !hitsOther(left, top) && (allowOverlap || (top < (item.bottom ?? item.top + 1) && top + panel.h > item.top));
  const topAtItem = clampY(item.top);
  const topAtParent = clampY(parent.top);
  // 以父面板（不是触发项）为基准：触发项长在父面板里，按它往左翻必然盖回父面板。
  const cands = [
    { left: parent.right + PANEL_GAP, top: topAtItem },
    { left: parent.left - PANEL_GAP - panel.w, top: topAtItem },
    { left: parent.right + PANEL_GAP, top: topAtParent },
    { left: parent.left - PANEL_GAP - panel.w, top: topAtParent },
  ];
  const ideal = cands.find((cd) => fitsClamp(cd.left, cd.top) && reachable(cd.left, cd.top));
  if (ideal) return ideal;
  // 次优：夹进 clamp 后仍要避开其它面板——贴边但不重叠，好过完整落位但压住上层。
  const fitted = cands
    .map((cd) => ({ left: clampX(cd.left), top: clampY(cd.top) }))
    .find((cd) => (allowOverlap || fitsClamp(cd.left, cd.top)) && reachable(cd.left, cd.top));
  if (fitted) return fitted;
  if (!allowOverlap) return null;
  // 兜底：窗口太窄，任何落点都会压到——贴父面板右侧夹取，宁可贴边也不叠在一起。
  return { left: clampX(parent.right + PANEL_GAP), top: clampY(topAtItem) };
}

/** 常规侧向落点放不下时，把桌面菜单整组并排放入可视区，优先让触发行留在鼠标下。 */
export function fitDesktopCascade(
  columns: { left: number; width: number }[],
  parentIndex: number,
  childWidth: number,
  pointerX: number,
  clamp: { x: number; w: number },
): { left: number; width: number }[] {
  const widths = [...columns.map((column) => column.width), childWidth];
  const gap = PANEL_GAP;
  const minLeft = clamp.x + PANEL_GAP;
  const available = clamp.w - PANEL_GAP * 2 - gap * (widths.length - 1);
  if (widths.reduce((total, width) => total + width, 0) > available) {
    const cap = Math.floor(available / widths.length);
    for (let i = 0; i < widths.length; i++) widths[i] = Math.min(widths[i], cap);
  }
  const parent = columns[parentIndex];
  const parentWidth = widths[parentIndex];
  const childIndex = columns.length;
  const order = columns.map((_, index) => index).sort((a, b) => columns[a].left - columns[b].left);
  const parentSlot = order.indexOf(parentIndex);
  const maxLeft = minLeft + available - widths.reduce((total, width) => total + width, 0);

  const candidate = (slot: number) => {
    const slots = order.slice();
    slots.splice(slot, 0, childIndex);
    const parentOffset = slots.slice(0, slots.indexOf(parentIndex)).reduce((sum, i) => sum + widths[i] + gap, 0);
    // Leave enough room for the item inset so a stationary pointer still hits the triggering row.
    const inset = Math.min(6, parentWidth / 2);
    const minAnchor = Math.max(minLeft, pointerX - parentOffset - parentWidth + inset);
    const maxAnchor = Math.min(maxLeft, pointerX - parentOffset - inset);
    const preferred = parent.left - parentOffset;
    const left =
      minAnchor <= maxAnchor
        ? Math.max(minAnchor, Math.min(preferred, maxAnchor))
        : Math.max(minLeft, Math.min(maxLeft, minAnchor));
    const parentLeft = left + parentOffset;
    return {
      left,
      slots,
      miss: Math.max(0, parentLeft + inset - pointerX, pointerX - (parentLeft + parentWidth - inset)),
      shift: Math.abs(parentLeft - parent.left),
    };
  };
  const right = candidate(parentSlot + 1);
  const left = candidate(parentSlot);
  const best = left.miss < right.miss || (left.miss === right.miss && left.shift < right.shift) ? left : right;
  const result = widths.map((width) => ({ left: 0, width }));
  let nextLeft = best.left;
  for (const index of best.slots) {
    result[index].left = nextLeft;
    nextLeft += widths[index] + gap;
  }
  return result;
}
