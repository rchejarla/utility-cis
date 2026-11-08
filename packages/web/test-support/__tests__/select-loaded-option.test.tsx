import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { selectLoadedOption } from "../select-loaded-option";

/**
 * The precondition a selection actually has.
 *
 * Three web tests failed on CI on 2026-11-07 and passed on every local
 * run. All three picked an option from a list the page fetches, having
 * waited only for the `<select>` — which renders first, holding its
 * placeholder. On an idle machine the fetch settles inside
 * `findByLabelText`'s first poll and the option is there by luck; on a
 * busy runner it is not, and `selectOptions` throws `Value not found`.
 *
 * The component below makes that timing explicit rather than leaving it
 * to the machine, so the helper is tested against the condition it
 * exists for.
 */

/** A select whose options arrive a macrotask later, as a fetch's would. */
function LateList({ onPick }: { onPick: (v: string) => void }) {
  const [options, setOptions] = useState<string[]>([]);
  const [value, setValue] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setOptions(["set-1", "set-2"]), 20);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <label htmlFor="season-set">Season set</label>
      <select
        id="season-set"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onPick(e.target.value);
        }}
      >
        <option value="">Choose a set…</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </>
  );
}

describe("picking an option that arrives with a fetch", () => {
  it("waits for the option, not just for the control", async () => {
    const picks: string[] = [];
    render(<LateList onPick={(v) => picks.push(v)} />);

    await selectLoadedOption("Season set", "set-2");

    expect(picks).toEqual(["set-2"]);
  });

  /*
   * The failure this replaces, pinned so the shape stays recognisable:
   * waiting for the control and selecting straight away throws, and
   * the message is the one that appeared in CI.
   */
  it("is what waiting for the control alone could not do", async () => {
    render(<LateList onPick={() => {}} />);

    await expect(
      userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-2"),
    ).rejects.toThrow(/Value "set-2" not found/);
  });
});
