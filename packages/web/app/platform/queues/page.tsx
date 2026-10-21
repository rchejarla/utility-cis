import { redirect } from "next/navigation";

/**
 * Where the Queues page used to live.
 *
 * It had grown to five subjects — the verdict, the nodes, the workers,
 * the queues and the jobs behind one count — so it became a Cluster
 * section of three pages. This redirect exists because the old path was
 * in the menu, in commit messages and in anyone's bookmarks.
 */
export default function PlatformQueuesRedirect() {
  redirect("/platform/cluster/queues");
}
