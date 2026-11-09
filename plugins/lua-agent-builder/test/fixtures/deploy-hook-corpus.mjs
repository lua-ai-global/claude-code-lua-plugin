// Regression corpus for the production-verb classifier (lib/tokenizer.mjs), 1.20.1.
//
// FALSE_POSITIVES are real commands that mention lua without running it. Every one of them was BLOCKED by 1.20.0
// (`DEPLOY_DENIED_BARE: lua <unresolved command>`, or `lua deploy` for a runner's prose) — most were seen live in a
// build session or in the session that wrote the fix. The real examples on their own were allowed by 1.20.0 too:
// they tripped the hook only next to a program the shell computes (`"$OPEN" "$URL"`, `$R/check.sh $R 8`), because
// "the command mentions lua" was asked of the whole line. MENTIONS are those examples on their own.
//
// TRUE_POSITIVES() generates every gated verb spelling through every launcher and shell context; every one must be
// blocked. EVAL_TRUE_POSITIVES are computed programs that may be lua (fail closed), including the variable-held
// command lines 1.20.0 let through (`C="lua deploy all"; $C`).

// The six examples from the build-session report, verbatim.
export const REAL_EXAMPLES = [
  'gh pr create --repo lua-ai-global/lua-website --title "feat: Lua Studio nav" --body "Adds the Lua Studio link to the header. Ships with the next lua-website deploy."',
  'kubectl get pods -n lua-build-sessions -l lua.ai/pool=1 -o wide',
  'curl -s https://lua.dev/agent-os/ | head -40',
  'grep -c "workspace.heylua.ai" dist/index.html',
  'gh repo clone lua-ai-global/lua-website /tmp/lua-website',
  "cat > docs/RELEASE.md <<'EOF'\n# Releasing\n\nNever run `lua deploy all` by hand: call request_release.\nlua version promote is done by the release.\nEOF",
];

/**
 * Mentions 1.20.0 counted as "lua" on their own (its token test split hosts and labels at `.`, and read prose
 * `Lua` and a repo path ending in `lua-cli` as the program): next to a computed program each one was blocked.
 */
export const COUNTED_AS_LUA_BY_1_20_0 = [
  'kubectl label node ip-10-0-1-5 lua.ai=pool-1 --overwrite',
  'curl -sI https://lua.dev',
  'open https://pop.heylua.ai',
  'gh pr list -R lua-ai-global/lua-cli --state open',
  'gh pr create -R lua-ai-global/lua-website --title "Lua Studio" --body "Lua Studio landing"',
  'grep -rn "Lua Studio" src/',
];

/** Programs the shell computes, run with computed arguments: each is fine on its own. */
const COMPUTED = [
  '"$OPEN" "$URL"',
  '$EDITOR "$FILE"',
  '${NODE:-node} "$SCRIPT"',
  '"$PY" "$SCRIPT" --out "$OUT"',
  '$KUBECTL logs "$POD"',
  '$R/check.sh $R 8',
  '"$(npm bin)/jest" "$TEST"',
  '"$HOME/.local/bin/uv" run "$X"',
];

export const MENTIONS = [
  ...REAL_EXAMPLES,
  ...COUNTED_AS_LUA_BY_1_20_0,
  'gh pr create --title "x" --body "Lua Studio: run lua deploy all after merge"',
  'kubectl get nodes -l lua.ai/pool=1 && kubectl top nodes -l lua.ai/pool=1',
  'curl -sI https://lua.dev/agent-os/ && curl -s https://lua.dev | grep -c "workspace.heylua.ai"',
  'gh repo view lua-ai-global/lua-cli --json name',
  'git -C ~/Documents/lua/lua-website log --oneline -3',
  'echo Lua Studio | tee note.txt',
];

export const FALSE_POSITIVES = [
  // Every real example next to every computed program, as one long line (`&&` and `;`).
  ...[...REAL_EXAMPLES, ...COUNTED_AS_LUA_BY_1_20_0].flatMap((m) => COMPUTED.flatMap((c) => [`${m} && ${c}`, `${c}; ${m}`])),
  // Verbatim commands blocked live while this fix was written (scratchpad paths shortened).
  "for n in alpha beta; do f=$R/agents/$n/src/skills/$n.tool.ts; cat > $f <<EOF\nimport { LuaTool } from 'lua-cli';\nexport default class T implements LuaTool { name = '${n}_tool'; }\nEOF\ndone\ncat > $R/check.sh <<'EOF'\n#!/bin/bash\n(cd $R/agents/alpha && lua compile --ci) &\n(cd $R/agents/beta && lua compile --ci) &\nwait\nEOF\nchmod +x $R/check.sh; $R/check.sh $R 8",
  'cd $S/wt-cli-compile/packages/lua-cli && PATH=/opt/homebrew/opt/node@22/bin:$PATH timeout 120 $S/core-pr/node_modules/.bin/tsx $S/compile-probe/inproc.mts $S/compile-repro 2>&1 | tail -8',
  "cd ~/x/plugins/lua-agent-builder && python3 - <<'EOF'\np='test.mjs'; s=open(p).read()\nold=\"['cd /x/lua/y && T=./s.sh; $T $SID; lua status', 1]\"\nopen(p,'w').write(s.replace(old, old))\nEOF\n$NODE \"$JEST\" test/lib",
  // The PR-body shape Claude Code writes, with a computed command after it.
  "gh pr create --title \"feat: Lua Studio\" --body \"$(cat <<'EOF'\n## Summary\n- Lua Studio onboarding (lua-ai-global/lua-website)\n- run `lua compile --ci` per agent\nEOF\n)\" && \"$BROWSER\" \"$PR_URL\"",
  'kubectl -n lua get pods -l lua.ai/pool=1 -o name | while read p; do $KC logs "$p" --tail 5; done',
  'for u in https://lua.dev/agent-os/ https://workspace.heylua.ai; do $CURL -s "$u" | $GREP -c Lua; done',
  'gh repo clone lua-ai-global/lua-website "$D" && cd "$D" && $PM install && $PM run build',
  'D=~/Documents/lua/lua-website; cd "$D" && "$PM" run "$TASK"',
  // A shell or runner whose CODE is prose about lua, or whose stdin is data.
  "bash -c 'echo Lua deploy notes are in docs/'",
  "kubectl exec pod -- sh -c 'curl -s https://lua.dev/agent-os/ | grep -c workspace.heylua.ai'",
  'ssh host "echo Lua Studio deploy window: Friday"',
  'echo "it is Lua; deploy later" | sh -c "cat > note.txt"',
  'printf "Lua deploy log\\n" | bash -c "tee -a log.txt"',
  'echo "lua deploy all" | xargs echo',
  "bash <<'EOF'\necho 'Lua deploy happens in Desktop'\nEOF",
];

/** Every spelling of every gated shape, `lua` first (from PRODUCTION_COMMANDS in lib/tokenizer.mjs). */
const SHAPES = [
  ['deploy'],
  ['skills', ['deploy', 'publish']],
  ['skills', ['production', 'prod', 'prd', 'live'], ['deploy', 'publish']],
  ['webhooks', ['deploy', 'publish']],
  ['jobs', ['deploy', 'publish']],
  ['preprocessors', ['deploy', 'publish']],
  ['postprocessors', ['deploy', 'publish']],
  ['persona', ['production', 'prod', 'prd', 'live'], ['deploy', 'publish']],
  ['workflows', ['deploy', 'publish']],
  ['workflows', ['activate', 'on', 'enable']],
  ['version', ['promote']],
  ['mcp', ['activate', 'on', 'enable']],
  ['marketplace', ['template', 'templates', 'agent-template', 'agent-templates'], ['publish', 'publish_version', 'submit']],
  ['marketplace', ['template', 'templates', 'agent-template', 'agent-templates'], ['apply', 'deploy', 'fleet-apply', 'rollout']],
];

export function verbSpellings() {
  const out = [];
  for (const shape of SHAPES) {
    let acc = [[]];
    for (const pos of shape) acc = acc.flatMap((a) => (Array.isArray(pos) ? pos : [pos]).map((p) => [...a, p]));
    out.push(...acc.map((a) => `${a.join(' ')} x --ci`));
  }
  return out;
}

const LAUNCHERS = [
  'lua', 'heylua', 'lua-ai', 'LUA', '/usr/local/bin/lua', './node_modules/.bin/lua', '"$DIR/lua"', 'npx lua',
  'npx -y lua-cli@latest', 'pnpm exec lua', 'pnpm dlx lua-cli', 'yarn lua', 'bunx lua', 'npm exec -- lua',
  'node node_modules/lua-cli/dist/index.js', 'FOO=1 lua', 'env FOO=1 lua', 'sudo -E lua', 'timeout 300 lua', 'nohup lua',
  'LUA_DEPLOY_CONFIRMED=1 npx lua', '$(which lua)', '`command -v lua`',
];

const CONTEXTS = [
  (x) => x,
  (x) => `cd agents/a && ${x}`,
  (x) => `true; ${x}`,
  (x) => `false || ${x}`,
  (x) => `${x} 2>&1 | tail -20`,
  (x) => `(${x})`,
  (x) => `{ ${x}; }`,
  (x) => `echo "$(${x})"`,
  (x) => `bash -c '${x.replace(/'/g, `'\\''`)}'`,
  (x) => `sh -lc "${x.replace(/["$`\\]/g, '\\$&')}"`,
  (x) => `eval '${x.replace(/'/g, `'\\''`)}'`,
  (x) => `ssh host ${x}`,
  (x) => `if ${x}; then echo ok; fi`,
  (x) => `${x} &`,
  (x) => `cat <<'EOF' | sh\n${x}\nEOF`,
  (x) => `bash <<'EOF'\n${x}\nEOF`,
  (x) => `C='${x.replace(/'/g, `'\\''`)}'; eval "$C"`,
  (x) => `gh pr create --body "Lua Studio" && ${x}`,
];

/** All generated true positives: verbs × launchers × contexts. */
export function TRUE_POSITIVES() {
  const out = [];
  for (const verb of verbSpellings()) {
    for (const launcher of LAUNCHERS) {
      for (const ctx of CONTEXTS) out.push(ctx(`${launcher} ${verb}`));
    }
  }
  return out;
}

/** Computed programs that may be lua: fail closed (blocked), including command lines held in a variable. */
export const EVAL_TRUE_POSITIVES = [
  'C="lua deploy all"; $C',
  'C="lua deploy all"; eval "$C"',
  "C='lua version promote 3'; bash -c \"$C\"",
  'export C="npx lua workflows deploy x -v 2"; sh -c "$C"',
  'C="lua deploy all --ci"; ssh host "$C"',
  'L=lua; V=deploy; $L $V all',
  'L=$(which lua); $L "$VERB" all',
  'for L in lua heylua; do $L "$V" all; done',
  'read L <<< lua; $L $V all',
  '$(printf lua) $(printf deploy) all',
  '${LUA_BIN:-lua} "$V" all',
  '$LUA_BIN "$VERB" all',
  'C=$(echo lua deploy all); eval "$C"',
  'C="$(printf lua) deploy"; $C all',
  "$'\\x6cua' \"$V\" all",
  '/usr/local/bin/lu? "$V" all',
  '{lua,} "$V" all',
  "bash -c '$1 $2 all' _ lua deploy",
  'T=./tools/release.sh; $T deploy all',
  '$T version promote 3',
  'X=lua; Y=$X; $Y $V all',
  'X=l; Y=ua; $X$Y $V all',
  'IFS=,; X="lua,deploy,all"; $X',
  "C='L=lua; $L $V all'; eval \"$C\"",
  "env L=lua sh -c '$L $V all'",
  "L=lua bash -c '$L \"$1\" all' _ deploy",
  'X=LUA; ${X,,} $V all',
];

/** Variables that hold other programs, next to a lua mention: allowed. */
export const NOT_LUA_VARIABLES = [
  'A=ls; B=-la; $A $B',
  'P=python3; S=x.py; $P $S',
  'gh pr create --body "Lua Studio" && A=ls; $A "$D"',
  'L=$(which lua); $L status --json --ci',
  '"$(command -v lua)" compile --ci',
  'L=lua; $L compile --ci && $L test skill --name x --input "{}" --ci',
  'cd /x/lua && "$PY" "$SCRIPT"',
  'LUA_BIN=lua; echo "$LUA_BIN"',
];
