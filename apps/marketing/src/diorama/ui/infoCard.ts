/**
 * DOM information card shown when a station is focused. Owner: UI worker.
 *
 * Mounted into the page element [data-diorama-card] (already absolutely
 * positioned by the page). Dark glass, 180 ms translate+opacity transition,
 * pointer-events none so it never blocks canvas dragging.
 */
import type { StationDef } from "../config/stations.js";
import { PALETTE, css } from "../config/palette.js";

export interface InfoCard {
  show(station: StationDef, statusOverride?: string): void;
  hide(): void;
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
.diorama-card-title{
  margin:0 0 6px;
  font-size:15px;
  font-weight:600;
  letter-spacing:.01em;
  color:#f5fbff;
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
@media (max-width:640px){
  .diorama-card-panel{
    max-width:calc(100% - 32px);
  }
}`;
  document.head.appendChild(style);
}

export function createInfoCard(root: HTMLElement): InfoCard {
  injectStyles();

  // Position inside the host: bottom-left, bottom-center when narrow.
  const setPosition = (narrow: boolean): void => {
    root.style.left = narrow ? "50%" : "20px";
    root.style.bottom = "20px";
    root.style.marginLeft = narrow ? "-170px" : "0";
  };
  const narrow = window.matchMedia("(max-width: 640px)");
  setPosition(narrow.matches);
  const onChange = (): void => setPosition(narrow.matches);
  narrow.addEventListener("change", onChange);

  const card = document.createElement("div");
  card.className = `diorama-card-panel diorama-card-hidden`;

  const title = document.createElement("h3");
  title.className = "diorama-card-title";

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

  card.append(title, blurb, status, relation);
  root.appendChild(card);

  return {
    show(station: StationDef, statusOverride?: string): void {
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
      // Force layout so consecutive shows still animate the transition.
      card.getBoundingClientRect();
      card.classList.remove("diorama-card-hidden");
    },
    hide(): void {
      card.classList.add("diorama-card-hidden");
    },
  };
}
