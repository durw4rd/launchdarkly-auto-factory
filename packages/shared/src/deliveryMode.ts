/**
 * The working-tree front ends (CLI, Cursor extension) leave every edit
 * uncommitted for the developer — by contract, not by accident. Agents only
 * learn that from commit_and_push's result, which a reviewer may never call,
 * and a model that reads "uncommitted, untracked" literally rejects the run
 * for it (observed live: Opus 5.5 rejected sound work as "not committed").
 * Stated once in every node's header, it also reaches the judges, whose
 * MESSAGE HISTORY is this prompt.
 */
export const WORKING_TREE_DELIVERY =
  "Delivery: working tree. This run leaves every edit uncommitted in the developer's checkout for them to " +
  "review and commit; nothing is committed or pushed, by design. Uncommitted and untracked files are the " +
  "expected deliverable, not a defect: assess the working tree as it stands.";
