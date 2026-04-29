import { prisma } from "../lib/prisma.js";

/**
 * Per-user inbox queries for the topbar bell. Strictly read-and-mark;
 * notifications are *written* by feature code (today: imports
 * notify.service) — this service is only the consumer side.
 *
 * RLS scopes everything to the current tenant, but bell-icon queries
 * also filter to the calling user's id so cross-user reads are
 * impossible even within a tenant.
 */

const UNREAD_DROPDOWN_LIMIT = 20;

export async function listUnreadNotifications(
  utilityId: string,
  userId: string,
): Promise<{
  data: Array<{
    id: string;
    kind: string;
    severity: string;
    title: string;
    body: string;
    link: string | null;
    createdAt: Date;
  }>;
  unreadCount: number;
}> {
  const [data, unreadCount] = await Promise.all([
    prisma.inAppNotification.findMany({
      where: { utilityId, userId, isRead: false },
      orderBy: { createdAt: "desc" },
      take: UNREAD_DROPDOWN_LIMIT,
      select: {
        id: true,
        kind: true,
        severity: true,
        title: true,
        body: true,
        link: true,
        createdAt: true,
      },
    }),
    prisma.inAppNotification.count({
      where: { utilityId, userId, isRead: false },
    }),
  ]);
  return { data, unreadCount };
}

export async function markNotificationRead(
  utilityId: string,
  userId: string,
  notificationId: string,
): Promise<{ id: string; isRead: true }> {
  // Update with both userId + utilityId in the where clause so a user
  // can't mark another user's notification read by guessing ids.
  // updateMany returns a count rather than throwing on no-match.
  const result = await prisma.inAppNotification.updateMany({
    where: { id: notificationId, utilityId, userId },
    data: { isRead: true, readAt: new Date() },
  });
  if (result.count === 0) {
    throw Object.assign(new Error("Notification not found"), {
      statusCode: 404,
      code: "NOT_FOUND",
    });
  }
  return { id: notificationId, isRead: true };
}

export async function markAllNotificationsRead(
  utilityId: string,
  userId: string,
): Promise<{ updated: number }> {
  const result = await prisma.inAppNotification.updateMany({
    where: { utilityId, userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return { updated: result.count };
}
