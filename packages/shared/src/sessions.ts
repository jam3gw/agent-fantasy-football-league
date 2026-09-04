/**
 * The decision log the runner writes when a session ends without the model
 * writing one, so every team session has a public summary (§15.4). The site
 * treats it as "no log": a row on `/sessions` says what happened to the
 * session instead of repeating the placeholder.
 */
export const NO_SUMMARY_PLACEHOLDER = "(no summary written)";
