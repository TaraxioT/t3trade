/**
 * Where T3 Trade keeps its state, and why it is not where T3 Code keeps its.
 *
 * The fork ships as a separate application that a user may install next to
 * upstream T3 Code. Two applications sharing `~/.t3` share one `state.sqlite`;
 * two sharing an Electron user-data directory share the single-instance lock
 * that lives inside it, so the second launch is handed to the first app. Both
 * failures are silent, and both hit a new user on their first run.
 *
 * Only the directory *names* fork. `T3CODE_HOME` keeps its name: it is opt-in,
 * so anyone who sets it means it, and renaming it would touch every call site
 * to buy nothing.
 */

/**
 * Base data directory under the user's home. Runtime state lives in `userdata`
 * beneath it, development state in `dev`, and the fork's provider keys in
 * `secrets` — which already lived here before the rest of the state joined it.
 */
export const T3_HOME_DIR_NAME = ".t3trade";

/** Electron `userData`, resolved under the platform's application-data directory. */
export const DESKTOP_USER_DATA_DIR_NAME = "t3trade";

/** The development build's `userData`, so a dev run cannot clobber an installed one. */
export const DESKTOP_USER_DATA_DIR_NAME_DEV = "t3trade-dev";
