import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Pick an option that arrives with a fetch of its own.
 *
 * A `<select>` whose list comes from the API renders *before* that list
 * does — the control is there, holding only its placeholder. So
 * `selectOptions(await findByLabelText("Season set"), "set-2")` waits
 * for the wrong thing: `findByLabelText` resolves on the first render
 * and `selectOptions` then throws `Value "set-2" not found`, because
 * the option it names does not exist yet.
 *
 * It passes on an idle machine, where the fetch settles inside
 * `findBy`'s first poll, and fails on a loaded one. That is the whole
 * story of three CI failures on 2026-11-07 that nobody could reproduce
 * locally: the runner was busy and this repo's own web suite starves
 * under parallel jsdom (see the `testTimeout` note in
 * `vitest.config.ts`).
 *
 * Waiting for the option rather than the control is not a stopwatch
 * papering over a race — it is the actual precondition the selection
 * has.
 */
export async function selectLoadedOption(
  label: string,
  value: string,
): Promise<HTMLSelectElement> {
  const select = await screen.findByLabelText<HTMLSelectElement>(label);
  await waitFor(() => {
    if (!select.querySelector(`option[value="${CSS.escape(value)}"]`)) {
      throw new Error(`Option "${value}" has not arrived in "${label}" yet`);
    }
  });
  await userEvent.selectOptions(select, value);
  return select;
}
