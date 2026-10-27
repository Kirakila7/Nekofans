// Electron positions, work areas and getCursorScreenPoint are all device-independent
// pixels. Do not multiply these values by a display's physical scaleFactor.
export interface Point { x: number; y: number }
export interface Rectangle extends Point { width: number; height: number }
export interface PetScreen {
  getPrimaryDisplay(): { workArea: Rectangle };
  getAllDisplays?(): Array<{ workArea: Rectangle }>;
  getCursorScreenPoint?(): Point;
  on?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}
export interface GeometryWindow {
  isDestroyed(): boolean;
  getPosition(): number[];
  setPosition(x: number, y: number): void;
  getBounds?(): Rectangle;
  setBounds?(bounds: Rectangle): void;
  webContents: { setZoomFactor?(factor: number): void };
}

const validPoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);
const validArea = (a: Rectangle) => validPoint(a) && Number.isFinite(a.width) && Number.isFinite(a.height) && a.width > 0 && a.height > 0;
const distance = (p: Point, area: Rectangle) => Math.hypot(
  Math.max(area.x - p.x, 0, p.x - area.x - area.width),
  Math.max(area.y - p.y, 0, p.y - area.y - area.height),
);

/** Select an actual monitor, never the empty bounding box between two monitors. */
export function matchingWorkArea(bounds: Rectangle, areas: Rectangle[], cursor?: Point): Rectangle {
  if (!areas.length) throw new Error("No display work area available.");
  const point = cursor ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const overlap = (area: Rectangle) => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x))
    * Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  return [...areas].sort((a, b) => cursor ? distance(point, a) - distance(point, b)
    : overlap(b) - overlap(a) || distance(point, a) - distance(point, b))[0];
}

/** Fully contain a pet and its controls in a real monitor's usable work area. */
export function fitPetBounds(position: Point, size: { width: number; height: number }, area: Rectangle): { bounds: Rectangle; zoom: number } {
  const zoom = Math.min(1, area.width / size.width, area.height / size.height);
  const width = Math.max(1, Math.floor(size.width * zoom));
  const height = Math.max(1, Math.floor(size.height * zoom));
  return { zoom, bounds: {
    x: Math.round(Math.min(Math.max(position.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(position.y, area.y), area.y + area.height - height)), width, height,
  } };
}

export interface PetGeometry {
  begin(fallback: Point): void;
  move(fallback: Point): void;
  end(): void;
  refresh(): void;
  dispose(): void;
}

/** One lifetime per pet window; callers dispose on close and failed initialization. */
export function managePetGeometry(win: GeometryWindow, screen: PetScreen, size: { width: number; height: number }): PetGeometry {
  let disposed = false;
  let zoom = 1;
  let anchor: Point | null = null;
  const events = ["display-added", "display-removed", "display-metrics-changed"];
  const bounds = () => {
    const [x, y] = win.getPosition();
    return win.getBounds?.() ?? { x, y, width: size.width, height: size.height };
  };
  const cursor = (fallback: Point) => {
    const point = screen.getCursorScreenPoint?.() ?? fallback;
    return validPoint(point) ? point : fallback;
  };
  const area = (current: Rectangle, point?: Point) => {
    const areas = (screen.getAllDisplays?.() ?? []).map((display) => display.workArea).filter(validArea);
    return matchingWorkArea(current, areas.length ? areas : [screen.getPrimaryDisplay().workArea], point);
  };
  const apply = (position: Point, target: Rectangle, restoreZoom = false) => {
    if (disposed || win.isDestroyed()) return;
    const fitted = fitPetBounds(position, size, target);
    if (win.setBounds && win.webContents.setZoomFactor) {
      if (restoreZoom || zoom !== fitted.zoom) win.webContents.setZoomFactor(fitted.zoom);
      zoom = fitted.zoom;
      win.setBounds(fitted.bounds);
    } else win.setPosition(fitted.bounds.x, fitted.bounds.y);
  };
  const refresh = () => {
    if (disposed || win.isDestroyed()) return;
    // Display topology changes terminate the old anchor; a removed monitor must
    // never drag the pet back to coordinates that no longer exist.
    anchor = null;
    const current = bounds();
    apply(current, area(current), true);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; anchor = null;
    if (screen.removeListener) for (const event of events) screen.removeListener(event, refresh);
  };
  try {
    refresh();
    if (screen.on && screen.removeListener) for (const event of events) screen.on(event, refresh);
  } catch (error) { dispose(); throw error; }
  return {
    begin(fallback) {
      if (disposed || win.isDestroyed() || !validPoint(fallback)) return;
      const point = cursor(fallback), current = bounds();
      anchor = { x: (point.x - current.x) / zoom, y: (point.y - current.y) / zoom };
    },
    move(fallback) {
      if (disposed || win.isDestroyed() || !anchor || !validPoint(fallback)) return;
      const point = cursor(fallback), current = bounds(), target = area(current, point);
      const nextZoom = fitPetBounds(current, size, target).zoom;
      apply({ x: point.x - anchor.x * nextZoom, y: point.y - anchor.y * nextZoom }, target);
    },
    end() { anchor = null; if (!disposed && !win.isDestroyed()) refresh(); },
    refresh, dispose,
  };
}
