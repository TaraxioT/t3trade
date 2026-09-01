/**
 * DOM information card shown when a station is focused. Owner: UI worker.
 *
 * Mounted into the page element [data-diorama-card] (already absolutely
 * positioned by the page). Dark glass, 180 ms translate+opacity transition.
 * The panel itself stays pointer-events:none so it never blocks canvas
 * dragging; the action and close buttons re-enable pointer events.
 *
 * Placement: when the caller supplies the focused station's screen position
 * (CSS pixels inside the diorama host), the card flips to the opposite side
 * horizontally and vertically so it never covers the station.
 */
import type { StationDef } from "../config/stations.js";
import { PALETTE, css } from "../config/palette.js";

/**
 * Card data: a configured station, or the synthetic Hyperliquid station whose
 * id is not part of StationId. StationDef is assignable to this shape.
 */
export interface CardStation extends Omit<StationDef, "id"> {
  id: string;
}

export interface InfoCard {
  show(station: CardStation, statusOverride?: string, stationScreen?: { x: number; y: number }): void;
  hide(): void;
  /** Remove DOM and listeners; safe to call twice. */
  destroy(): void;
}

export interface InfoCardOptions {
  /** Runs the station's demo story (Director.runStory). */
  onAction?: (storyId: string) => void;
  /** Close button: interaction passes clearSelection. */
  onClose?: () => void;
}

const STYLE_ID = "diorama-infocard-style";

/** Heuristic status color: semantic palette keyed off status wording. */
function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (/(refus|denied|exceed|blocked|emergency|fail|stale|drift)/.test(s)) return css(PALETTE.blocked);
  if (/(degrad|amber|warning|retry|loss)/.test(s)) return css(PALETTE.warning);
  if (/(healthy|protect|shield|align|green|sealed|armed)/.test(s)) return css(PALETTE.healthy);
  return css(PALETTE.waiting);
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.diorama-card-panel{
  pointer-events:none;
  max-width:340px;
  padding:14px 16px;
  border-radius:12px;
  background:rgba(10,24,40,.92);
  border:1px solid rgba(52,229,229,.25);
  backdrop-filter:blur(8px);
  -webkit-backdrop-filter:blur(8px);
  box-shadow:0 10px 32px rgba(3,10,18,.5);
  color:#f5fbff;
  font-family:'DM Sans',system-ui,sans-serif;
  transition:transform .18s ease,opacity .18s ease;
}
.diorama-card-hidden{
  opacity:0;
  transform:translateY(10px);
}
.diorama-card-head{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:8px;
}
.diorama-card-title{
  margin:0 0 6px;
  font-size:15px;
  font-weight:600;
  letter-spacing:.01em;
  color:#f5fbff;
}
.diorama-card-close{
  flex:none;
  width:44px;
  height:44px;
  margin:-8px -10px -8px 0;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  border:none;
  border-radius:10px;
  background:transparent;
  color:#a8c0cf;
  cursor:pointer;
  pointer-events:auto;
  font-size:10px;
  line-height:1;
}
.diorama-card-close:hover{color:#f5fbff}
.diorama-card-close:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:2px;
}
.diorama-card-blurb{
  margin:0 0 8px;
  font-size:13px;
  line-height:1.5;
  color:#a8c0cf;
}
.diorama-card-status{
  display:flex;
  align-items:center;
  gap:7px;
  margin:0;
}
.diorama-card-dot{
  width:7px;height:7px;border-radius:50%;
  box-shadow:0 0 6px currentColor;
  background:currentColor;
  flex:none;
}
.diorama-card-status-text{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:10px;
  letter-spacing:.12em;
  text-transform:uppercase;
  color:#a8c0cf;
}
.diorama-card-relation{
  display:flex;
  flex-wrap:wrap;
  align-items:center;
  gap:4px;
  margin-top:8px;
}
.diorama-card-chip{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:9px;
  letter-spacing:.08em;
  text-transform:uppercase;
  padding:2px 7px;
  border-radius:999px;
  border:1px solid rgba(52,229,229,.3);
  color:#53C8FF;
  background:rgba(52,229,229,.07);
}
.diorama-card-arrow{
  color:#5a7cff;
  font-size:10px;
  line-height:1;
}
.diorama-card-action{
  display:block;
  width:100%;
  min-height:44px;
  margin-top:10px;
  padding:6px 14px;
  border-radius:10px;
  border:1px solid rgba(52,229,229,.4);
  background:rgba(52,229,229,.12);
  color:#34E5E5;
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:11px;
  letter-spacing:.08em;
  text-transform:uppercase;
  cursor:pointer;
  pointer-events:auto;
  transition:background .15s ease,border-color .15s ease;
}
.diorama-card-action:hover{
  background:rgba(52,229,229,.2);
  border-color:rgba(52,229,229,.6);
}
.diorama-card-action:focus-visible{
  outline:2px solid #34E5E5;
  outline-offset:2px;
}
@media (max-width:640px){
  .diorama-card-panel{
    max-width:calc(100% - 32px);
  }
}`;
  document.head.appendChild(style);
}

export function createInfoCard(root: HTMLElement, opts: InfoCardOptions = {}): InfoCard {
  injectStyles();

  // Default position inside the host: bottom-left, bottom-center when narrow.
  const clearPosition = (): void => {
    root.style.left = "";
    root.style.right = "";
    root.style.top = "";
    root.style.bottom = "";
    root.style.marginLeft = "";
  };
  const setDefaultPosition = (narrow: boolean): void => {
    clearPosition();
    root.style.left = narrow ? "50%" : "20px";
    root.style.bottom = "20px";
    root.style.marginLeft = narrow ? "-170px" : "0";
  };
  /**
   * Flip the card to the opposite side of the host from the station's screen
   * position so the focused station stays visible.
   */
  const setFlippedPosition = (stationScreen: { x: number; y: number }): void => {
    clearPosition();
    const stationLeft = stationScreen.x < (root.parentElement?.clientWidth ?? window.innerWidth) / 2;
    const stationTop = stationScreen.y < (root.parentElement?.clientHeight ?? window.innerHeight) / 2;
    if (stationLeft) {
      root.style.left = "";
      root.style.right = "20px";
    } else {
      root.style.left = "20px";
      root.style.right = "";
    }
    if (stationTop) {
      root.style.top = "";
      root.style.bottom = "20px";
    } else {
      root.style.top = "20px";
      root.style.bottom = "";
    }
  };
  const narrow = window.matchMedia("(max-width: 640px)");
  setDefaultPosition(narrow.matches);
  const onChange = (): void => setDefaultPosition(narrow.matches);
  narrow.addEventListener("change", onChange);

  const card = document.createElement("div");
  card.className = `diorama-card-panel diorama-card-hidden`;
  card.setAttribute("aria-live", "polite");

  const head = document.createElement("div");
  head.className = "diorama-card-head";

  const title = document.createElement("h3");
  title.className = "diorama-card-title";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "diorama-card-close";
  closeBtn.setAttribute("aria-label", "Close station details");
  closeBtn.textContent = "x";
  closeBtn.addEventListener("click", () => opts.onClose?.());

  head.append(title, closeBtn);

  const blurb = document.createElement("p");
  blurb.className = "diorama-card-blurb";

  const status = document.createElement("p");
  status.className = "diorama-card-status";
  const dot = document.createElement("span");
  dot.className = "diorama-card-dot";
  const statusText = document.createElement("span");
  statusText.className = "diorama-card-status-text";
  status.append(dot, statusText);

  const relation = document.createElement("div");
  relation.className = "diorama-card-relation";

  const actionBtn = document.createElement("button");
  actionBtn.type = "button";
  actionBtn.className = "diorama-card-action";
  actionBtn.hidden = true;
  actionBtn.addEventListener("click", () => {
    const storyId = actionBtn.dataset.storyId;
    if (storyId) opts.onAction?.(storyId);
  });

  card.append(head, blurb, status, relation, actionBtn);
  root.appendChild(card);

  return {
    show(station, statusOverride?, stationScreen?): void {
      title.textContent = station.label;
      blurb.textContent = station.blurb;
      const statusLine = statusOverride ?? station.status;
      statusText.textContent = statusLine;
      dot.style.color = statusColor(statusLine);
      relation.textContent = "";
      if (station.relation) {
        // "A -> B -> C" becomes small chips separated by arrow glyphs.
        const parts = station.relation.split("→").map((p) => p.trim()).filter(Boolean);
        parts.forEach((part, i) => {
          if (i > 0) {
            const arrow = document.createElement("span");
            arrow.className = "diorama-card-arrow";
            arrow.textContent = "→";
            relation.appendChild(arrow);
          }
          const chip = document.createElement("span");
          chip.className = "diorama-card-chip";
          chip.textContent = part;
          relation.appendChild(chip);
        });
      }
      if (station.action && station.story) {
        actionBtn.textContent = station.action;
        actionBtn.setAttribute("aria-label", station.action);
        actionBtn.dataset.storyId = station.story;
        actionBtn.hidden = false;
      } else {
        actionBtn.hidden = true;
        delete actionBtn.dataset.storyId;
      }
      if (stationScreen) setFlippedPosition(stationScreen);
      else setDefaultPosition(narrow.matches);
      // Force layout so consecutive shows still animate the transition.
      card.getBoundingClientRect();
      card.classList.remove("diorama-card-hidden");
    },
    hide(): void {
      card.classList.add("diorama-card-hidden");
    },
    destroy(): void {
      narrow.removeEventListener("change", onChange);
      card.remove();
    },
  };
}
