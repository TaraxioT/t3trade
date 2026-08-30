// Central scene configuration: audited T3 palette, island layout, metadata.
// Every color here traces to the pixel-sampled icon audit
// (artifacts/research/icon-palette.json). Nothing is invented.

export const PALETTE = {
  scene: {
    background: 0x061426,
    fog: 0x0a2140,
    key: 0xfff2df, //warm top-left key, the V2 lighting language
    rim: 0x5fa8d8,
    hemiSky: 0x2a4a7a,
    hemiGround: 0x0a0f1e,
  },
  v1: {
    prod: {
      greens: [0x56e5ad, 0x07d281, 0x19f792, 0x6be8b8, 0x31faa0],
      facets: [0x145a43, 0x187652],
    },
    dev: { navy: [0x051c3a, 0x0b3258, 0x184669], teals: [0x29a4ba, 0x36b6ce, 0x44ebfc] },
    nightly: {
      mint: [0x55f7b2, 0x4ce6b0, 0x14e888, 0x2cf795, 0x0cc88a],
      deep: [0x0d4746, 0x0e6755],
    },
  },
  v2: {
    prod: {
      white: 0xf9fafa,
      ramp: [0xd5d7d8, 0xc6c8ca, 0xa6a8ab, 0x747679, 0x66676a, 0x47484b, 0x353738],
    },
    dev: { ice: 0xe7fefe, blues: [0xb1d8f2, 0xc5eaf9, 0x8eb7d4], steel: 0x4e7694 },
    nightly: { white: 0xfdfefe, ice: 0xd3f7f6, teals: [0x227457, 0x1c664d, 0x1a5746] },
  },
  v3: {
    prod: { white: 0xfefefe, cyan: 0x30d4e6, steel: [0x214b67, 0x2c627c, 0x317891] },
    dev: { cyans: [0x51d8eb, 0x2cd7e7], steel: [0x2e7791, 0x50a4bb, 0x2b6985, 0x174566] },
    nightly: { glow: 0x86fbfe, steel: [0x0f374c, 0x0e4458, 0x11566a, 0x32768a, 0x4898ab] },
  },
  shared: {
    indigo: 0x2a2ad8, //#00007F lifted for visibility on navy; the DNA accent
    profit: 0x07d281,
    profitLight: 0x56e5ad,
    loss: 0xe14b33,
    lossDeep: 0xb03a2e,
  },
  //Shared natural tones used across biomes, kept low-key so palette marks pop
  earth: {
    soil: 0x6e4f38,
    soilDark: 0x4a3627,
    rock: 0x7d848e,
    rockDark: 0x4b515b,
    wood: 0x8a6239,
    woodDark: 0x5f462c,
    water: 0x3f9ac0,
    waterDeep: 0x2a6f96,
  },
};

//Island layout. The ring is deliberately irregular: varied radius, elevation
//and slight rotation keep silhouettes readable from the default camera.
export const ISLANDS = [
  {
    id: "forest",
    key: "1",
    name: "Central Forest",
    family: "V1 Faceted + V2 + V3",
    channel: "Prod",
    position: [0, 0, 0],
    rotationY: 0.08,
    size: 21,
    thickness: 4.4,
    focus: { azimuth: 0.62, polar: 0.86, distance: 52, offset: [0, 2.5, 0] },
    blurb:
      "The unified T3 identity. Faceted peaks carry the V1 green ramp, layered strata give V2 depth, and the river runs as a glowing V3 plotted line from the mountains, past the cabin, over the slab edge.",
    details: "cabin · rain cloud · river + waterfall · candlestick path markers · T3 monument",
  },
  {
    id: "farm",
    key: "2",
    name: "Prod Farm",
    family: "V1 Faceted",
    channel: "Prod",
    position: [-24, -3.6, -33],
    rotationY: 0.2,
    size: 12.5,
    thickness: 3,
    focus: { azimuth: 0.9, polar: 0.88, distance: 34, offset: [0, 1.5, 0] },
    blurb:
      "Faceted gambrel roofs and a windmill under warm prod daylight. The vegetable rows are laid out as a candlestick chart: green columns rising with the season, one red row pulling back.",
    details: "barn · tractor · windmill · candlestick crop rows · fences · sunflowers · hay",
  },
  {
    id: "desert",
    key: "3",
    name: "Dev Oasis",
    family: "V1 Faceted",
    channel: "Dev",
    position: [39, 5, 5],
    rotationY: 0.3,
    size: 12.8,
    thickness: 3,
    focus: { azimuth: 1.1, polar: 0.9, distance: 33, offset: [0, 1.5, 0] },
    blurb:
      "Faceted dunes stepped like a depth chart, rock strata in dev navy, and a teal oasis pond. The indigo awning carries the electric accent shared by every dev icon.",
    details: "oasis pond · palms · cacti · camel · plotted teal road · indigo awning",
  },
  {
    id: "beach",
    key: "4",
    name: "Dev Shore",
    family: "V2 Dimensional",
    channel: "Dev",
    position: [-21, -1, 35],
    rotationY: 3.44,
    size: 12.5,
    thickness: 3,
    focus: { azimuth: 1.0, polar: 0.95, distance: 36, offset: [0, 1.2, 0] },
    blurb:
      "Ice-white sand and layered dimensional shelves. The lifeguard tower uses the extruded white of the V2 mark; pale-blue water meets the slab side with an animated foam edge.",
    details: "lifeguard tower · umbrellas · loungers · swimmers · foam edge · rock shelves",
  },
  {
    id: "glacier",
    key: "5",
    name: "Dev Glacier",
    family: "V3 Blueprint",
    channel: "Dev",
    position: [-37, 6, 15],
    rotationY: 0.26,
    size: 12.5,
    thickness: 3.2,
    focus: { azimuth: 0.55, polar: 0.9, distance: 34, offset: [0, 2, 0] },
    blurb:
      "Cool blueprint illumination. A cyan plotted line runs beneath the frozen stream to the tile edge, the research station carries crosshair marks, and a cable car glides between pylons.",
    details: "snow peaks · research station · cable car · frozen stream · drifting snow",
  },
  {
    id: "volcano",
    key: "6",
    name: "Nightly Caldera",
    family: "V1 Faceted",
    channel: "Nightly",
    position: [-8, 2.6, -38.5],
    rotationY: -0.3,
    size: 12.5,
    thickness: 3.2,
    focus: { azimuth: 0.8, polar: 0.92, distance: 34, offset: [0, 2.5, 0] },
    blurb:
      "The darkest island, in nightly atmosphere. A faceted basalt caldera where the lava channel reads as a descending red trajectory, spilling over the slab edge under drifting ash.",
    details: "faceted volcano · lava trajectory · monitoring station · burnt trees · ash column",
  },
  {
    id: "wetlands",
    key: "7",
    name: "Nightly Wetlands",
    family: "V3 Blueprint",
    channel: "Nightly",
    position: [28, -1.4, -28],
    rotationY: 0.18,
    size: 13.2,
    thickness: 3,
    focus: { azimuth: 0.9, polar: 0.92, distance: 34, offset: [0, 1.5, 0] },
    blurb:
      "Reflective dark water with blueprint grid fragments floating on the surface. Glowing mushrooms, raised walkways and plotted cyan lines turn the marsh into a live circuit.",
    details: "glow mushrooms · walkways · observation post · grid fragments · fog · motes",
  },
];

export const DEFAULT_VIEW = {
  azimuth: 0.62,
  polar: 0.86,
  distance: 93,
  target: [0, 4.5, 0],
};
