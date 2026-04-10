"use client";

import { useState } from "react";
import { Tabs } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { UsersTab } from "@/components/settings/users-tab";
import { RolesTab } from "@/components/settings/roles-tab";

const TABS = [
  { key: "users", label: "Users" },
  { key: "roles", label: "Roles" },
];

export default function SettingsPage() {
  const { canView, canCreate } = usePermission("settings");
  const [activeTab, setActiveTab] = useState("users");
  const [showAddUser, setShowAddUser] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);

  if (!canView) return <AccessDenied />;

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    // Close any open forms when switching tabs
    setShowAddUser(false);
    setShowAddRole(false);
  };

  const handleAddAction = () => {
    if (activeTab === "users") {
      setShowAddUser((prev) => !prev);
      setShowAddRole(false);
    } else {
      setShowAddRole((prev) => !prev);
      setShowAddUser(false);
    }
  };

  const actionLabel =
    activeTab === "users"
      ? showAddUser
        ? "Cancel"
        : "+ Add User"
      : showAddRole
        ? "Cancel"
        : "+ Add Role";

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Manage users and roles for your organization"
        action={
          canCreate
            ? {
                label: actionLabel,
                onClick: handleAddAction,
              }
            : undefined
        }
      />

      <Tabs tabs={TABS} activeTab={activeTab} onTabChange={handleTabChange}>
        {activeTab === "users" && (
          <UsersTab
            showAddForm={showAddUser}
            onAddFormClose={() => setShowAddUser(false)}
          />
        )}
        {activeTab === "roles" && (
          <RolesTab
            showAddForm={showAddRole}
            onAddFormClose={() => setShowAddRole(false)}
          />
        )}
      </Tabs>
    </div>
  );
}
