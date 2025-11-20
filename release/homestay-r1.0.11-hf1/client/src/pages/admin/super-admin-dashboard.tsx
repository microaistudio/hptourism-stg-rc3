import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Shield,
  Zap,
  Database,
  MapPin,
  CreditCard,
  Server,
  Lock,
  Activity,
  FileText,
  Wrench,
  LucideIcon,
} from "lucide-react";
import { Link } from "wouter";

interface DashboardStats {
  applications: {
    total: number;
    approved: number;
    pending: number;
    draft: number;
  };
  inspections: {
    scheduled: number;
  };
  payments: {
    pending: number;
    completed: number;
  };
}

type SectionConfig = {
  id: string;
  title: string;
  description: string;
  tabs: Array<{
    id: string;
    label: string;
    description: string;
    actions: Array<{
      title: string;
      description: string;
      href: string;
      icon: LucideIcon;
      badge?: string;
    }>;
    insights?: string[];
  }>;
};

const SECTIONS: SectionConfig[] = [
  {
    id: "pipelines",
    title: "Pipelines & HimKosh",
    description: "Control district routing, HimKosh credentials, and pipeline health.",
    tabs: [
      {
        id: "routing",
        label: "District Routing",
        description: "Map districts/tehsils to their pipelines and DDO codes.",
        actions: [
          {
            title: "DDO Routing Matrix",
            description: "Configure the district → tehsil → DDO mapping table and preview pipeline counts.",
            href: "/admin/super-console#ddo-routing",
            icon: MapPin,
          },
          {
            title: "Legacy Owner Queue",
            description: "Monitor legacy RC onboarding and ensure each pipeline has a DA/DTDO assigned.",
            href: "/admin/super-console#legacy-owner",
            icon: Activity,
          },
        ],
        insights: [
          "Use the routing matrix before enabling new districts in production.",
          "Keep the DDO manifest in sync with HimKosh account changes.",
        ],
      },
      {
        id: "himkosh",
        label: "HimKosh Integration",
        description: "Manage payment credentials and reporting.",
        actions: [
          {
            title: "Credential Locker",
            description: "Update HIMKOSH230/230/TSM logins, cert expiry reminders, and RC series mapping.",
            href: "/admin/super-console#himkosh",
            icon: CreditCard,
          },
          {
            title: "Payment Health Monitor",
            description: "View failed callbacks, stuck verifications, and resend payment instructions.",
            href: "/payment-verification",
            icon: Shield,
          },
        ],
        insights: [
          "Always test credentials on staging before rotating production certificates.",
          "Set reminders 7 days before token expiry to avoid downtime.",
        ],
      },
    ],
  },
  {
    id: "database",
    title: "Database & Seeds",
    description: "High-impact actions that change storage, seeds, and migrations.",
    tabs: [
      {
        id: "reset",
        label: "Reset & Seeds",
        description: "Dangerous utilities reserved for platform maintenance.",
        actions: [
          {
            title: "Seed Toolkit",
            description: "Run DA/DTDO seeding scripts, regenerate demo data, or restore golden backups.",
            href: "/admin/super-console#seeds",
            icon: Wrench,
            badge: "Danger Zone",
          },
          {
            title: "SQL Workbench",
            description: "Ad-hoc SQL console with read/write access. Always export results before mutating.",
            href: "/admin/super-console#sql",
            icon: Database,
          },
        ],
        insights: [
          "Never seed production during business hours.",
          "Export snapshots before running destructive queries.",
        ],
      },
      {
        id: "storage",
        label: "Storage & Object Store",
        description: "Manage affidavits, RC PDFs, and encryption keys.",
        actions: [
          {
            title: "Object Store Browser",
            description: "Inspect uploaded documents, move items between buckets, or delete sensitive files.",
            href: "/admin/super-console#storage",
            icon: Server,
          },
          {
            title: "Encryption Keys",
            description: "Rotate storage keys and download the latest manifest for DR drills.",
            href: "/admin/super-console#encryption",
            icon: Lock,
          },
        ],
      },
    ],
  },
  {
    id: "security",
    title: "Security & Audit",
    description: "OTP throttles, login policies, and exportable audit trails.",
    tabs: [
      {
        id: "otp",
        label: "OTP & Login",
        description: "Toggle OTP modes, brute-force limits, and login banners.",
        actions: [
          {
            title: "OTP Policy",
            description: "Switch between relaxed/dev OTP and strict 2-step verification.",
            href: "/admin/super-console#security",
            icon: Zap,
          },
          {
            title: "Login Notices",
            description: "Publish maintenance alerts or compliance warnings for all officers.",
            href: "/admin/super-console#communications",
            icon: FileText,
          },
        ],
      },
      {
        id: "audit",
        label: "Audit & Logs",
        description: "Export event logs or schedule automatic deliveries.",
        actions: [
          {
            title: "Audit Timeline",
            description: "Download CSV/JSON audit logs or push them to the SIEM connector.",
            href: "/admin/audit-log",
            icon: Shield,
          },
          {
            title: "Legacy Dashboard",
            description: "Need the previous widgets? Open the legacy dashboard at /admin/super-dashboard-old.",
            href: "/admin/super-dashboard-old",
            icon: Activity,
            badge: "Legacy",
          },
        ],
      },
    ],
  },
];

export default function SuperAdminDashboard() {
  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["/api/admin/dashboard/stats"],
  });
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);

  const quickStats = useMemo(
    () => [
      {
        title: "Applications",
        value: stats?.applications.total ?? "—",
        sub: `${stats?.applications.pending ?? 0} pending`,
      },
      {
        title: "Approvals",
        value: stats?.applications.approved ?? "—",
        sub: `${stats?.applications.draft ?? 0} drafts`,
      },
      {
        title: "Inspections",
        value: stats?.inspections.scheduled ?? "—",
        sub: "Scheduled",
      },
      {
        title: "Payments",
        value: stats?.payments.completed ?? "—",
        sub: `${stats?.payments.pending ?? 0} pending`,
      },
    ],
    [stats],
  );

  return (
    <div className="container mx-auto max-w-7xl p-6 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.3em] uppercase text-muted-foreground">Superadmin Workspace</p>
          <h1 className="text-3xl font-bold mt-1">Platform Control Tower</h1>
          <p className="text-muted-foreground mt-2">
            Route payments, seed databases, and enforce security policies from a single pane of glass.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/super-console">Launch Super Console</Link>
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {quickStats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{stat.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground mt-1">{stat.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <aside className="lg:w-64">
          <Card className="sticky top-6">
            <CardHeader>
              <CardTitle>Control Areas</CardTitle>
              <CardDescription>Select a pillar to focus on.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {SECTIONS.map((section) => (
                <Button
                  key={section.id}
                  variant={activeSection === section.id ? "default" : "ghost"}
                  className="w-full justify-start"
                  onClick={() => setActiveSection(section.id)}
                >
                  {section.title}
                </Button>
              ))}
            </CardContent>
          </Card>
        </aside>

        <div className="flex-1 space-y-6">
          {SECTIONS.map((section) => (
            <div key={section.id} className={activeSection === section.id ? "space-y-4" : "hidden"}>
              <div>
                <h2 className="text-2xl font-semibold">{section.title}</h2>
                <p className="text-muted-foreground">{section.description}</p>
              </div>

              <Tabs defaultValue={section.tabs[0]?.id}>
                <TabsList className="flex-wrap justify-start">
                  {section.tabs.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id}>
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {section.tabs.map((tab) => (
                  <TabsContent key={tab.id} value={tab.id} className="space-y-4">
                    <Card>
                      <CardHeader>
                        <CardTitle>{tab.label}</CardTitle>
                        <CardDescription>{tab.description}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="grid gap-4 md:grid-cols-2">
                          {tab.actions.map((action) => (
                            <Card key={action.title}>
                              <CardHeader className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <action.icon className="w-4 h-4 text-primary" />
                                  <CardTitle className="text-base">{action.title}</CardTitle>
                                  {action.badge && <Badge variant="outline">{action.badge}</Badge>}
                                </div>
                                <CardDescription>{action.description}</CardDescription>
                              </CardHeader>
                              <CardContent>
                                <Button asChild variant="secondary" className="w-full">
                                  <Link href={action.href}>Open</Link>
                                </Button>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </CardContent>
                    </Card>

                    {tab.insights && tab.insights.length > 0 && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Operating Notes</CardTitle>
                          <CardDescription>Guidelines for this area.</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <ul className="ml-6 list-disc space-y-2 text-sm text-muted-foreground">
                            {tab.insights.map((note) => (
                              <li key={note}>{note}</li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    )}
                  </TabsContent>
                ))}
              </Tabs>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
