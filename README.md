# Libre Poker · play

**https://librepoker.org/play/** — heads-up fixed-limit hold'em against a
near-unexploitable trainer: solved preflop (Cepheus), trained middle
streets, every river solved exactly as you play it.

Schema-native by construction: every finished hand becomes a
[Hand document](https://github.com/libre-poker/schema), and the
scorecard, transcript, leak meter, and both copy buttons are pure views
over those documents. The live table is the only view that reads the
engine directly.

- 🎯 the leak meter — river EV loss vs the exact solve, bb/100, live
- 📋 the scorecard — every hand, its cards, its cost; click for the
  transcript, copy as text or as a Hand document
- 🏅 rated — 40-hand matches vs the level, Glicko-2, assistance
  structurally removed, everything revealed only after
- keys: `1` fold · `2` check/call · `3` bet/raise · `4` coach · `5` leak

Engine modules are vendored from
[libre-poker/engine](https://github.com/libre-poker/engine) (see
`engine/VENDORED.md`). No build step, no server, no dependencies.

License: AGPL-3.0.
