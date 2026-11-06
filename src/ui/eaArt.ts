/* EA's own card art for FutCard (FC 27 Web App CDN – the same files the Web App shows; nothing is drawn by us).
   The rarity table is EA's Web App rarity config (id → art guid, whether the art has bronze/silver/gold levels,
   the rarity's text colours: three per level for levelled rarities – ink, contrast, line). A rarity that is not in
   the table has no known art: FutCard draws the plain card outline instead (never a guessed colour). */

export const EA_IMG = "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/content/27A3C9F1-6B2E-4D7A-8C1F-2E9B5A4D6C7E/2027/fut/items/images";

/** rareflag → [art guid, levelled (bronze/silver/gold art), text colours "ink contrast line …"] */
const RARITY: Record<number, [guid: string, levels: 0 | 1, colors: string]> = {
  0: ["929f3299-a61e-4ff1-abda-7663f1c835db", 1, "3e281c e6a46b 9c6446 1e252a c1c4cf 566770 2d2410 e1be5d 8a7442"],
  1: ["7535d322-3347-4123-a800-cf93bcd5d786", 1, "3e281c e6a46b 9c6446 1e252a c1c4cf 566770 2d2410 e1be5d 8a7442"],
  3: ["39536884-f4a8-4ac1-8962-09ad897ee4ea", 1, "d98b68 0f0d0d 603e2f e0e0e0 0f0d0d 5b5b5b f6db7b 0f0d0d 574e2c"],
  8: ["07e4628d-88c8-4f38-b087-72eec050daed", 0, "fffaf3 d36f0d ffc439"],
  9: ["06713a8e-864d-4419-99b4-3ab3e78683e9", 0, "fcfcfc 860f19 81868b"],
  10: ["90248b4e-7d67-4ca0-be01-112b4af866d7", 0, "fef7b9 860f19 a39964"],
  12: ["26a75c17-3c46-4bc8-ae53-42e8c60efd92", 0, "54462b dbdbdb 94792e"],
  19: ["e26d6efe-c340-436c-8d71-f6d5bef4b2ad", 0, "f7e39c 4e0e0e 574e2c"],
  22: ["b5f97f5d-a300-407c-a62e-2d81fde66d97", 0, "fff3cf 005256 1ad9a9"],
  25: ["0e2de8b5-e3e5-41d5-93dd-79602a458071", 0, "fcfaff 3c195b e7d573"],
  42: ["0bdfa8f4-f4ab-4e69-8f27-60466d146528", 0, "ffffff 93020e d10214"],
  43: ["42445ce2-2c51-43ea-a4d9-f074cae2c504", 0, "ffffff 3d195b 00f5ff"],
  45: ["f65289d2-1c47-498b-8538-e7e2695202d3", 0, "edfaff 622ab1 52f6ff"],
  51: ["f9d0f35f-3628-4ebd-847f-f07601dfd42e", 0, "fcfcf7 2d187f ff4be0"],
  56: ["def7d392-4f8c-4c25-99ea-11683faebe6e", 0, "e6ffcf 249582 45dbc3"],
  57: ["39c75375-09e9-4999-bec7-52253c1f793d", 0, "e1ff85 313634"],
  58: ["20ed9fb6-8284-4df8-b303-8175a34fdcce", 0, "f2f2f2 3f3f3f"],
  66: ["570ec9e6-8704-4933-af15-ebd2ea40e4e2", 0, "ffffff 2a084f f09bff"],
  71: ["b9a7e5a2-3026-4ef8-8ec7-1f5cc1e4601c", 0, "ffffff 2a084f f09bff"],
  72: ["02125655-f210-4864-9262-ed283b9e54e8", 0, "ffd44f 242d61 f97af8"],
  79: ["93759a7e-8c55-48ae-aaf8-33ab972d3e5f", 0, "ffffff 262626 ff7fde"],
  86: ["8ead496c-0253-40f3-9f9f-0b76addb8ce1", 0, "ffffff 00001b ff4b44"],
  87: ["6dbabef4-efd7-4d12-9211-c56c0956df19", 0, "fff6dd 05433e 3feae8"],
  90: ["faa8a872-ced9-40d0-84c4-b177bfb6a0c0", 0, "fcfcf7 303636 31ebda"],
  99: ["7b687de2-71e3-47b7-a775-f698bb618ad6", 0, "ffffff 6c1ac8 3b105c"],
  100: ["0de232c1-7a37-417e-aa23-da4a8ff5e960", 0, "f5f5f5 8cb185 97c090"],
  101: ["a0d41efe-9303-49cd-8f9f-bd4e56a46a8e", 0, "00ffea 6c0dcc 983fe9"],
  102: ["e77f87ae-d193-48fe-a3da-170e17a53f67", 0, "fafd00 e3642f ffab5e"],
  103: ["001b228d-439d-4143-8191-ab2ec9e11834", 0, "ffe9ca 4e2611 a39964"],
  110: ["32d1f3c1-2585-4ad7-9e9d-335c6b4fa4aa", 0, "fff5d0 4c1072 814ba8"],
  114: ["9459ed72-3f48-472b-b4b7-23e20e40503c", 0, "ffffff 171d88 00e8da"],
  115: ["cdaab2bb-15d4-4912-8b3e-3c2d289ade8c", 0, "ffffff 220090 ec1846"],
  121: ["fe2719fd-94b9-452e-9002-fcd0212e8a22", 0, "ffffff"],
  122: ["3d33cc24-ed58-428a-9449-5cebd8c1c908", 0, "ffffff"],
  129: ["4c200033-9382-491c-8040-9830b8d73398", 0, "ffffff 121212 b6af8a"],
  130: ["ad9412f6-2358-4327-a4fc-b33456984052", 0, "ffffff 021137 31729e"],
  131: ["fb936f1c-363b-4e30-a1f8-645e489a3f43", 0, "ffffff 191b1c 2c4f4c"],
  150: ["1a383901-e6ff-46fa-8d50-2e2e79ff270a", 0, "fffdd8 043b61 91b68a"],
  151: ["df4460ae-3f34-4a90-8207-a07ade5e3bdf", 0, "fff1d7 673486 cf94bc"],
  160: ["4b3e1e2d-20ec-441f-a232-363363a41ebd", 0, "3b2d11 dbdbdb 94792e"],
  161: ["699bb3fe-57cb-4e44-b7ae-ce18ecae6646", 0, "3b2d11 dbdbdb 94792e"],
  168: ["3a6a196b-c455-4417-b894-e2b05853b6db", 0, "f3f9ff 403fdb 55b6ce"],
  177: ["6f0f63f1-617c-453b-b95c-29ebde858b5d", 0, "f3f3f3 00256a 00ead2"],
};

/** 1 bronze · 2 silver · 3 gold (EA's level thresholds) */
export const cardLevel = (rating: number) => (rating >= 75 ? 3 : rating >= 65 ? 2 : 1);

export type CardArt = { bg: string; ink: string; alt: string; line: string };

/** EA's background and text colours for a rarity + rating, or null when the rarity's art is not known. */
export function cardArt(rareflag: number | null | undefined, rating: number | null | undefined): CardArt | null {
  const r = RARITY[rareflag ?? -1];
  if (!r) return null;
  const [guid, levels, colors] = r;
  const lvl = levels ? cardLevel(rating ?? 0) : 0;
  const t = colors.split(" ").map((c) => "#" + c);
  const off = t.length >= 9 ? (cardLevel(rating ?? 0) - 1) * 3 : 0;
  return {
    bg: `${EA_IMG}/backgrounds/itemBGs/${guid}/cards_bg_e_1_${rareflag}_${lvl}.png`,
    ink: t[off] ?? "#2d2410",
    alt: t[off + 1] ?? t[off] ?? "#2d2410",
    line: t[off + 2] ?? t[off + 1] ?? "rgba(0,0,0,.3)",
  };
}

/** a base portrait from a definition id or asset id (EA: asset = definition % 2^24) */
export const portraitUrl = (id: number) => `${EA_IMG}/mobile/portraits/${id % 16777216}.png`;
/** a special's action shot (the item's own art guid, from the Web App) */
export const actionShotUrl = (guid: string, defId: number) => `${EA_IMG}/actionShot/${guid}/p${defId}.png`;
export const flagUrl = (nation: number) => `${EA_IMG}/mobile/flags/light/${nation}.png`;
export const leagueUrl = (league: number) => `${EA_IMG}/mobile/leagues/light/${league}.png`;
export const clubUrl = (club: number) => `${EA_IMG}/mobile/clubs/light/${club}.png`;
/* EA's holographic foil (hyperCosmetics type 1 = Foil, asset 1112) and the hyper-rare sticker */
const FOIL = { guid: "d501d11a-1db5-42af-b96a-6a61d33f0119", id: 1112 };
export const foilUrl = (t: "si" | "ss") => `${EA_IMG}/hypercosmetics/${FOIL.guid}/foilAnimLayer_e_${t}_${FOIL.id}.png`;
export const stickerUrl = (firstOwner: boolean) =>
  `https://www.ea.com/ea-sports-fc/ultimate-team/web-app/images/Items/stickers/${firstOwner ? "hyper-rare-first-owned" : "hyper-rare"}.png`;
