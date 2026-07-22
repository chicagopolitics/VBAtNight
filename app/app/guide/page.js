import { getSessionUser, isOrganizer } from "@/lib/auth";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

const S = {
  h2: { marginTop: 28, borderBottom: "1px solid #262b36", paddingBottom: 6 },
  step: { margin: "10px 0" },
  kbd: { background: "#232936", border: "1px solid #384050", borderRadius: 4,
         padding: "1px 6px", fontSize: 12 },
  code: { background: "#232936", borderRadius: 4, padding: "1px 6px", fontSize: 13 },
};

function Step({ n, title, children }) {
  return (
    <div className="card" style={S.step}>
      <b>{n}. {title}</b>
      <div className="muted" style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

export default async function Guide() {
  if (!isOrganizer(await getSessionUser())) redirect("/login");
  return (
    <div style={{ maxWidth: 760 }}>
      <h1>How-to guide</h1>
      <p className="muted">
        The two workflows, end to end. Everything Colab-side lives in Drive/balltime;
        everything review-side lives in this app.
      </p>

      <h2 style={S.h2}>1 · Process a game night</h2>
      <Step n={1} title="Record & trim">
        One video file per game. Trim each so it starts at the first serve
        (that lets the notebook keep GAME_START = 0:00).
      </Step>
      <Step n={2} title="Calibrate the camera (per tripod position)">
        If the tripod moved between games: <a href="/setup">Camera setup</a> →
        select the night&apos;s video files → click the court geometry for each →
        download <span style={S.code}>courts_config.json</span> → upload it to
        Drive/balltime (replace the old one).
      </Step>
      <Step n={3} title="Upload to Drive">
        Copy the trimmed videos into Drive/balltime. The folder must also hold a
        current <span style={S.code}>vbpipe.zip</span> (re-upload only after pipeline
        code changes — rebuild locally with <span style={S.code}>pipeline/make_bundle.sh</span>)
        and <span style={S.code}>ball_model.pt</span> (persists; trained once, improved via workflow 2).
      </Step>
      <Step n={4} title="Run the processing notebook">
        Open <span style={S.code}>process_game.ipynb</span> (v8+) in Colab.
        Runtime → T4 GPU → Run all. It processes every video without a bundle yet
        (~30–40 min each), writes bundles to Drive/balltime/bundles, and resumes
        if Colab disconnects — just Run all again. If you hit GPU limits, wait a
        few hours or use Pay-As-You-Go.
      </Step>
      <Step n={5} title="Import into the app">
        Download the bundle zips → <a href="/import">Import game</a> → select them
        all. Game names come from the filenames. Bundles ship the full game video;
        rallies play as clips of it.
      </Step>
      <Step n={6} title="Name the players">
        Per game: Identities page. Name everyone under &quot;Involved in scored
        touches&quot; first, then merge fragments into them (the merge popup only
        offers named players — name before merging). Accept/reject the embedding
        match suggestions; split mixed clusters; mark clean ones &quot;Done ✓&quot;.
      </Step>
      <Step n={7} title="Review the transcript">
        Play review page. Timeline = whole recording; gaps are dead time — click a
        gap to seek there. Per rally: fix touches (chips), boundaries
        (&quot;start/end here&quot;), split merged rallies, add missed ones
        (&quot;+ rally at playhead&quot;), dismiss junk (&quot;not a rally&quot;),
        set the outcome. Hotkeys: <span style={S.kbd}>←</span>/<span style={S.kbd}>→</span> rallies,
        {" "}<span style={S.kbd}>A</span> add touch, <span style={S.kbd}>Tab</span> +
        letters in the chip editor, <span style={S.kbd}>Enter</span> closes it.
        Amber chips = shaky attribution; red dashed = no player.
      </Step>
      <Step n={8} title="Publish">
        Toggle publish on the game → players see <a href="/watch">Watch</a> and{" "}
        <a href="/stats">Stats</a>.
      </Step>

      <h2 style={S.h2}>2 · Improve the model</h2>
      <p className="muted">
        The flywheel: your review corrections are labeled training data. Each round
        makes the next review lighter. Nothing updates automatically — these steps
        are the update.
      </p>
      <Step n={1} title="Finish a full review">
        A game counts once touches, players, and outcomes are done (workflow 1,
        steps 6–7). Deleting all touches in a messy rally and re-adding them is
        fine — the scorer matches by time, not lineage. Just set type + player on
        every touch you add.
      </Step>
      <Step n={2} title="Export the corrections">
        Easiest: on the Games page, click <b>Export corrections</b> next to the
        game. It writes <span style={S.code}>corrections_game&lt;id&gt;.json</span>{" "}
        into the <span style={S.code}>app/</span> folder — no typing, already
        where the upload step wants it.
        <br /><br />
        Or from the command line, in the <span style={S.code}>app/</span> folder,{" "}
        passing the numeric game id first:{" "}
        <span style={S.code}>npm run export -- &lt;game_id&gt; corrections_&lt;name&gt;.json</span>{" "}
        (e.g. <span style={S.code}>npm run export -- 14 corrections_game14.json</span>).
        The filename must match the video stem (corrections_game2.json for game2.mp4).
      </Step>
      <Step n={3} title="(Optional) score the pipeline locally">
        From <span style={S.code}>pipeline/</span>:{" "}
        <span style={S.code}>python -m vbpipe.eval_corrections corrections_X.json game.json</span>{" "}
        (game.json extracted from that game&apos;s bundle zip). Reads: contact
        precision/recall (the bottleneck metric), play-type confusion, attribution,
        rallies missed. Compare across rounds to see progress.
      </Step>
      <Step n={4} title="Upload corrections to Drive">
        Copy the corrections_*.json files into Drive/balltime (plus a fresh
        vbpipe.zip if the pipeline changed).
      </Step>
      <Step n={5} title="Run the training notebook">
        Open <span style={S.code}>ball_gen2.ipynb</span> in Colab → T4 GPU → Run all
        (~30–45 min). It mines physics-verified ball arcs from every processed game,
        adds hard negatives, fine-tunes to ball_model_v2.pt, and prints a v1-vs-v2
        scorecard against your corrections. Run all is safe — it never promotes on
        its own.
      </Step>
      <Step n={6} title="Promote if v2 wins">
        In Cell 6 set <span style={S.code}>PROMOTE = True</span> and re-run that cell
        (it backs up v1). Then delete the bundles you want reprocessed from
        Drive/balltime/bundles, Run all in process_game.ipynb, and re-import here.
      </Step>
      <Step n={7} title="Repeat as data accumulates">
        Each reviewed game adds corrections; re-run the training notebook when a few
        new ones pile up. Around 15–20 reviewed games, a learned play-typer (replacing
        the rules) becomes viable — that&apos;s the next big lever after ball detection.
      </Step>

      <h2 style={S.h2}>Troubleshooting quickies</h2>
      <div className="card muted">
        <p style={{ marginTop: 0 }}><b>Colab says no GPU</b> — free-tier limit. Wait a few
        hours; don&apos;t &quot;connect without GPU&quot; (the notebook will refuse anyway).</p>
        <p><b>Notebook errored mid-run</b> — fix the cause, Run all again; both notebooks
        resume where they left off.</p>
        <p><b>NameError after leaving Colab overnight</b> — the runtime recycled; Run all
        re-establishes state (promotion Cell 6 is self-contained).</p>
        <p style={{ marginBottom: 0 }}><b>Import fails</b> — bundle zips are multi-GB;
        the upload streams and extracts via system tar. If it errors, check disk space
        and retry; the error message says what broke.</p>
      </div>
    </div>
  );
}
