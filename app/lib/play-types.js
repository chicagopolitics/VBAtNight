// The touch vocabulary, in hotkey order (1..6 in the review UI).
export const PLAY_TYPES = ["serve", "receive", "dig", "set", "attack", "block"];

// Volleyball possession order, reduced to what's knowable from the preceding
// touch alone — a hand-added touch has no player, position or side yet:
//   serve -> receive -> set -> attack -> dig -> set -> attack -> ...
// Mirrors classify() in pipeline/vbpipe/plays.py (touch 1 of a possession is
// receive/dig, touch 2 is set, touch 3+ is attack), minus the side/net-distance
// tests it uses to spot blocks and possession changes. A block deflection is
// normally covered or dug.
const NEXT = { serve: "receive", receive: "set", dig: "set",
               set: "attack", attack: "dig", block: "dig" };

// prev = play_type of the touch immediately BEFORE this one in time, or
// null/undefined when the new touch is the earliest in its rally.
export const predictPlayType = prev =>
  prev == null ? "serve" : (NEXT[prev] || "attack");
