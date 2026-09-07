/**
 * Station registry: district builders register one handle per interactive
 * station. The interaction layer resolves pointer events to handles, the
 * camera focuses them, and stories reach station animation APIs through
 * typed accessors (see stationApi).
 */
import { Rectangle, type Container } from "pixi.js";
import type { StationId } from "../config/stations.js";

export interface StationHandle {
  id: StationId;
  /** Station root inside the sortable layer; zIndex already set by builder. */
  root: Container;
  /**
   * Invisible hit surface (eventMode static) sized to the station footprint.
   * Kept as a child of root; interaction listens here.
   */
  hit: Container;
  /** Station-specific animation surface; see each station module's interface. */
  api?: object;
}

const handles = new Map<StationId, StationHandle>();

export function registerStation(handle: StationHandle): void {
  // Bare Containers have no containsPoint, so a Graphics-only hit surface
  // never passes Pixi's geometry hit test. Derive an explicit hitArea from
  // the surface's local bounds; the builders' transparent diamonds provide
  // the geometry.
  if (handle.hit && !handle.hit.hitArea) {
    const b = handle.hit.getLocalBounds();
    if (b.width > 0 && b.height > 0) {
      handle.hit.hitArea = new Rectangle(b.x - 2, b.y - 2, b.width + 4, b.height + 4);
    }
  }
  handles.set(handle.id, handle);
}

export function getStation(id: StationId): StationHandle | undefined {
  return handles.get(id);
}

export function allStations(): StationHandle[] {
  return [...handles.values()];
}

/** Typed accessor for story code: stationApi<ApprovalApi>("approval"). */
export function stationApi<T extends object>(id: StationId): T | undefined {
  return handles.get(id)?.api as T | undefined;
}

/** Reset for tests and rebuilds. */
export function clearRegistry(): void {
  handles.clear();
}
