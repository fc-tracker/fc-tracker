/* Dev only (`?view=ui` on the dev server): every src/ui part in one page, to check them against
   design/d-draft-2/components.html in all three themes. Cards use the user's real club from the mockup data
   (design/_shared/data.js, local only – never shipped); without it the page shows the parts that need no data. */
import { useEffect, useState } from "react";
import { useTheme, THEMES } from "../theme";
import {
  Bar, Btn, Chem, Chip, Coin, Dot, FaceChip, FutCard, GToken, Gem, Grade, Keycap, Mark, Num, Panel, Range, Rank, RankRow,
  Score, Segs, Switch, Tabs, Tag, Ticks, ToGrade, Token, type FutCardData,
} from "./index";

type Raw = { name: string; rating: number; pos: string; positions?: string[]; face?: number[]; rareflag: number; asset: number; def?: number; holo?: boolean; fo?: boolean;
  pp?: string[]; foot?: "L" | "R"; skill_moves?: number; weak_foot?: number; meta?: Record<string, number>; nation?: number; league?: number; club?: number; img?: { portrait?: string } };

const toCard = (p: Raw): FutCardData => {
  const action = p.img?.portrait?.match(/actionShot\/([^/]+)\//)?.[1] ?? null;
  return {
    name: p.name, rating: p.rating, position: p.pos, positions: p.positions, face: p.face, rareflag: p.rareflag, defId: p.def ?? p.asset, actionGuid: action,
    holo: p.holo, firstOwner: p.fo, pp: p.pp, foot: p.foot, skillMoves: p.skill_moves, weakFoot: p.weak_foot,
    meta: p.meta ? Math.max(...Object.values(p.meta)) : null, nation: p.nation, league: p.league, club: p.club,
  };
};

export default function UiGallery() {
  const [theme, setTheme] = useTheme();
  const [players, setPlayers] = useState<Raw[]>([]);
  const [tab, setTab] = useState("sets");
  const [seg, setSeg] = useState("1");
  const [on, setOn] = useState(true);
  const [r, setR] = useState(40);
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "/design/_shared/data.js";
    s.onload = () => setPlayers(((window as unknown as { FCT?: { players: Raw[] } }).FCT?.players ?? []) as Raw[]);
    document.head.appendChild(s);
  }, []);
  const pick = (f: (p: Raw) => boolean) => players.find(f);
  const cards = [pick((p) => p.rareflag > 1 && !!p.face), pick((p) => !!p.holo), pick((p) => p.rareflag === 1 && p.rating >= 75), pick((p) => p.rating < 75 && p.rating >= 65), pick((p) => p.rating < 65), pick((p) => p.pos === "GK")].filter(Boolean) as Raw[];
  return (
    <div className="ui-gallery" style={{ padding: 32, display: "grid", gap: 24, minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--f-body)" }}>
      <div className="row" style={{ gap: 8 }}>
        {THEMES.map((th) => (
          <Btn key={th} kind={th === theme ? "ink" : "secondary"} size="s" onClick={() => setTheme(th)}>{th}</Btn>
        ))}
      </div>
      <Panel cut="xl" signed tier="hero" className="pad">
        <div className="col">
          <span className="eyebrow">Overlay</span>
          <span className="h1">Your weekend.</span>
          <span className="row base"><Num value={970} size="l" unit="tokens" /><Score a={12} b={3} className="num-m" /></span>
          <span className="row"><Gem /><Num value={1361729} /><Coin /><Num value={632369} /><Token /><Num value={215} /><GToken /><Num value={35} /></span>
        </div>
      </Panel>
      <Panel className="pad">
        <div className="col">
          <Tabs items={[{ id: "sets", label: "Sets", count: "14/128" }, { id: "value", label: "Best value" }, { id: "champions", label: "Champions", count: <Score a={12} b={3} /> }]} active={tab} onChange={setTab} />
          <Segs items={[{ id: "1", label: "1. Rivals", count: 22 }, { id: "2", label: "2. Squad Battles", count: 8 }]} active={seg} onChange={setSeg} />
          <div className="hints"><Keycap ps="✕" xb="A" label="Select" /><Keycap ps="□" xb="X" label="Details" /><Keycap ps="○" xb="B" label="Back" /><Keycap ps="View" label="Hold · overlay" /></div>
          <div className="row wrap"><Chip>Neutral</Chip><Chip tone="done"><Dot tone="done" />Synced</Chip><Chip tone="warn">Action needed</Chip><Chip tone="ink">Ink</Chip><Chip tone="accent">Buy</Chip><Chip tone="beta">Beta</Chip><Tag tone="done">FO</Tag><Tag tone="ink">XI</Tag><Tag>EVO</Tag></div>
          <div className="row"><Btn kind="primary">Primary</Btn><Btn>Secondary</Btn><Btn kind="quiet">Quiet</Btn><Btn kind="ink" size="s">Ink</Btn></div>
          <div className="row"><Grade g="D" /><Grade g="C" /><Grade g="B" /><Grade g="A" /><Grade g="S" /><Grade g={null} /><Grade g="S" size="xl" /><ToGrade from="C" to="B" /></div>
          <div className="row"><Rank i={3} got /><Rank i={7} got size="m" /><Rank i={12} got size="l" /><Rank i={13} next size="l" /><Rank i={14} size="l" /></div>
          <RankRow wins={12} />
          <div className="row" style={{ width: 400 }}><Bar value={0.6} /><Bar value={0.8} tone="done" size="thick" /></div>
          <div style={{ width: 400 }}><Ticks items={["w", "w", "w", "w", "l", "w", "w", "l", "w", "w", "w", "w", "w", "w", "l"]} /></div>
          <div className="row"><Chem n={2} /><Switch on={on} onChange={setOn} label="Toggle" /><div style={{ width: 200 }}><Range value={r} min={0} max={100} onChange={setR} label="Range" /></div></div>
          <div className="list rule" style={{ width: 420 }}>
            <div className="lrow is-sel" data-f style={{ gridTemplateColumns: "1fr auto" }}><span>Selected row</span><Num value={625} /></div>
            <div className="lrow" data-f style={{ gridTemplateColumns: "1fr auto" }}><span>Row (hover = plate)</span><Num value={3200} /></div>
          </div>
        </div>
      </Panel>
      <Panel className="pad">
        <div className="row wrap" style={{ alignItems: "flex-end", gap: 20 }}>
          {cards.map((p, i) => <FutCard key={i} card={toCard(p)} focus={i === 0} />)}
          {cards.slice(0, 3).map((p, i) => <FutCard key={`s${i}`} card={toCard(p)} size="small" />)}
          {cards.slice(0, 3).map((p, i) => <FutCard key={`m${i}`} card={toCard(p)} size="mini" w={64} />)}
          <FutCard card={{ name: "Hernández", rating: 71, position: "LB", defId: 272522 }} toGet size="small" />
          <FutCard card={{ name: "Unknown rarity", rating: 80, position: "CM", rareflag: 9999, defId: 239085 }} size="small" />
          {cards.slice(0, 3).map((p, i) => <FaceChip key={`f${i}`} card={toCard(p)} />)}
          <Mark />
        </div>
        {!players.length && <p className="muted">design/_shared/data.js not found – cards need the local mockup data.</p>}
      </Panel>
    </div>
  );
}
