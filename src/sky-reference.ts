/** Reference sky decoration for the HUD globe: J2000 bright-star asterisms
 * and a few well-known deep-sky objects. These are orientation aids only;
 * they are not survey coverage and carry no provenance claims. */
export interface ReferenceStar { ra: number; dec: number }

export interface ReferenceAsterism {
  name: string;
  label: [ra: number, dec: number];
  stars: Record<string, [ra: number, dec: number]>;
  lines: Array<[string, string]>;
}

export interface ReferenceObject { name: string; ra: number; dec: number }

export const REFERENCE_ASTERISMS: readonly ReferenceAsterism[] = [
  {
    name: "URSA MAJOR",
    label: [186, 62.5],
    stars: { dubhe: [165.93, 61.75], merak: [165.46, 56.38], phecda: [178.46, 53.69], megrez: [183.86, 57.03], alioth: [193.51, 55.96], mizar: [200.98, 54.93], alkaid: [206.89, 49.31] },
    lines: [["dubhe", "merak"], ["merak", "phecda"], ["phecda", "megrez"], ["megrez", "dubhe"], ["megrez", "alioth"], ["alioth", "mizar"], ["mizar", "alkaid"]],
  },
  {
    name: "ORION",
    label: [84, 13],
    stars: { betelgeuse: [88.79, 7.41], bellatrix: [81.28, 6.35], meissa: [83.78, 9.93], alnitak: [85.19, -1.94], alnilam: [84.05, -1.2], mintaka: [83.0, -0.3], saiph: [86.94, -9.67], rigel: [78.63, -8.2] },
    lines: [["meissa", "betelgeuse"], ["meissa", "bellatrix"], ["betelgeuse", "alnitak"], ["bellatrix", "mintaka"], ["alnitak", "alnilam"], ["alnilam", "mintaka"], ["alnitak", "saiph"], ["mintaka", "rigel"]],
  },
  {
    name: "CASSIOPEIA",
    label: [15, 66],
    stars: { caph: [2.29, 59.15], schedar: [10.13, 56.54], gamma: [14.18, 60.72], ruchbah: [21.45, 60.24], segin: [28.6, 63.67] },
    lines: [["caph", "schedar"], ["schedar", "gamma"], ["gamma", "ruchbah"], ["ruchbah", "segin"]],
  },
  {
    name: "CYGNUS",
    label: [304, 49],
    stars: { deneb: [310.36, 45.28], sadr: [305.56, 40.26], gienah: [311.55, 33.97], delta: [296.24, 45.13], albireo: [292.68, 27.96] },
    lines: [["deneb", "sadr"], ["sadr", "albireo"], ["delta", "sadr"], ["sadr", "gienah"]],
  },
  {
    name: "LEO",
    label: [162, 27],
    stars: { regulus: [152.09, 11.97], eta: [151.83, 16.76], algieba: [154.99, 19.84], adhafera: [154.17, 23.42], rasalas: [148.19, 26.01], epsilon: [146.46, 23.77], zosma: [168.53, 20.52], chertan: [168.56, 15.43], denebola: [177.26, 14.57] },
    lines: [["regulus", "eta"], ["eta", "algieba"], ["algieba", "adhafera"], ["adhafera", "rasalas"], ["rasalas", "epsilon"], ["algieba", "zosma"], ["zosma", "denebola"], ["denebola", "chertan"], ["chertan", "regulus"]],
  },
  {
    name: "BOÖTES",
    label: [220, 44],
    stars: { arcturus: [213.92, 19.18], izar: [221.25, 27.07], delta: [228.88, 33.31], nekkar: [225.49, 40.39], seginus: [218.02, 38.31], muphrid: [208.67, 18.4] },
    lines: [["arcturus", "izar"], ["izar", "delta"], ["delta", "nekkar"], ["nekkar", "seginus"], ["seginus", "arcturus"], ["arcturus", "muphrid"]],
  },
  {
    name: "SCORPIUS",
    label: [244, -16],
    stars: { graffias: [241.36, -19.81], dschubba: [240.08, -22.62], pi: [239.71, -26.11], sigma: [245.3, -25.59], antares: [247.35, -26.43], tau: [248.97, -28.22], epsilon: [252.54, -34.29], mu: [252.97, -38.05], zeta: [254.66, -42.36], eta: [258.04, -43.24], sargas: [264.33, -43.0], iota: [266.9, -40.13], kappa: [265.62, -39.03], shaula: [263.4, -37.1] },
    lines: [["graffias", "dschubba"], ["dschubba", "pi"], ["dschubba", "sigma"], ["sigma", "antares"], ["antares", "tau"], ["tau", "epsilon"], ["epsilon", "mu"], ["mu", "zeta"], ["zeta", "eta"], ["eta", "sargas"], ["sargas", "iota"], ["iota", "kappa"], ["kappa", "shaula"]],
  },
  {
    name: "CRUX",
    label: [187, -54],
    stars: { acrux: [186.65, -63.1], mimosa: [191.93, -59.69], gacrux: [187.79, -57.11], delta: [183.79, -58.75] },
    lines: [["acrux", "gacrux"], ["mimosa", "delta"]],
  },
  {
    name: "PEGASUS",
    label: [354, 33],
    stars: { markab: [346.19, 15.21], scheat: [345.94, 28.08], algenib: [3.31, 15.18], alpheratz: [2.1, 29.09] },
    lines: [["markab", "scheat"], ["scheat", "alpheratz"], ["alpheratz", "algenib"], ["algenib", "markab"]],
  },
];

export const REFERENCE_OBJECTS: readonly ReferenceObject[] = [
  { name: "M31", ra: 10.68, dec: 41.27 },
  { name: "M42", ra: 83.82, dec: -5.39 },
  { name: "M45", ra: 56.75, dec: 24.12 },
  { name: "M51", ra: 202.47, dec: 47.2 },
  { name: "M101", ra: 210.8, dec: 54.35 },
  { name: "M87", ra: 187.71, dec: 12.39 },
  { name: "M104", ra: 190.0, dec: -11.62 },
  { name: "M13", ra: 250.42, dec: 36.46 },
  { name: "LMC", ra: 80.89, dec: -69.76 },
  { name: "SMC", ra: 13.19, dec: -72.83 },
];
