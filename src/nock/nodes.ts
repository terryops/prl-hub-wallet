// The two public Nockchain nodes (client.ts says how they are used), apart from the client so the page can
// name them without loading the core.
export const NOCKBOX = "https://rpc.nockbox.org", CLI_NODE = "http://216.158.95.10:5556";
/// The extension's optional host permission for the second node (manifest `optional_host_permissions`): the
/// NOCK page asks for it only after rpc.nockbox.org failed, as an optional permission never disables the
/// extension on update. A host pattern covers every port. The Android app reaches that node through its shell
/// and needs no such step.
export const CLI_NODE_PERMISSION = { origins: ["http://216.158.95.10/*"] };
