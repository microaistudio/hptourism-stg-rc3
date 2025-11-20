import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "wouter";
import { Bell, Users, ClipboardList, ClipboardCheck, MapPin, ShieldCheck, FileText, Download } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type AdminSection = {
  id: string;
  title: string;
  description: string;
  tabs: Array<{
    id: string;
    label: string;
    actions: Array<{
      title: string;
      description: string;
      icon: LucideIcon;
      href: string;
      badge?: string;
    }>;
    helper?: string;
  }>;
};

const SECTIONS: AdminSection[] = [
  {
    id: "operations",
    title: "Licensing Operations",
    description: "Monitor RC workloads, chase bottlenecks, and issue certificates.",
    tabs: [
      {
        id: "applications",
        label: "Applications",
        actions: [
          {
            title: "RC Applications Workspace",
            description: "Filter, export, or drill into any owner application.",
            href: "/admin/rc-applications",
            icon: ClipboardList,
          },
          {
            title: "Audit Timeline",
            description: "Investigate escalations or trace approvals via audit log.",
            href: "/admin/audit-log",
            icon: FileText,
          },
        ],
        helper: "Use this workspace for monthly reviews or when sharing updates with districts.",
      },
      {
        id: "certificates",
        label: "Certificates",
        actions: [
          {
            title: "RC Certificate Generator",
            description: "Generate or re-issue RC PDFs for assisted applicants.",
            href: "/admin/rc-application-certificate",
            icon: Download,
          },
          {
            title: "Existing RC Support",
            description: "Guide legacy license holders through onboarding.",
            href: "/admin/legacy-owner-support",
            icon: ClipboardCheck,
          },
        ],
        helper: "Use when coordinating with call-centre agents or DTDO escalations.",
      },
    ],
  },
  {
    id: "staff",
    title: "Staff & Directories",
    description: "Manage officer rosters, LGD data, and escalation contacts.",
    tabs: [
      {
        id: "users",
        label: "Officer Accounts",
        actions: [
          {
            title: "User Management",
            description: "Create/disable DA, DTDO, and Admin logins.",
            href: "/admin/users",
            icon: Users,
          },
          {
            title: "LGD Importer",
            description: "Sync LGD districts/blocks into the latest build.",
            href: "/admin/lgd-import",
            icon: MapPin,
          },
        ],
        helper: "Keep LGD imports aligned with staff manifests before unlocking districts.",
      },
      {
        id: "escalations",
        label: "Escalation Contacts",
        actions: [
          {
            title: "District Contact Sheet",
            description: "Download/update escalation contacts used by SMS alerts.",
            href: "/admin/console-old#contacts",
            icon: Bell,
          },
        ],
        helper: "Legacy contact editor opens in the previous console layout.",
      },
    ],
  },
  {
    id: "communications",
    title: "Announcements & Policy",
    description: "Coordinate owner-facing messaging and OTP policy through the Super Console.",
    tabs: [
      {
        id: "announcements",
        label: "Announcements",
        actions: [
          {
            title: "Global Notices",
            description: "Publish/retire homepage banners and alert strips.",
            href: "/admin/console-old#banners",
            icon: Bell,
          },
          {
            title: "Owner Dashboard Copy",
            description: "Update hero headline or dashboard info cards.",
            href: "/admin/console-old#homepage",
            icon: ClipboardList,
          },
        ],
        helper: "Legacy console panels open in a new tab while we migrate the forms here.",
      },
      {
        id: "security",
        label: "Security Policy",
        actions: [
          {
            title: "OTP / Security Controls",
            description: "Toggle relaxed OTP, brute-force limits, or login locks.",
            href: "/admin/console-old#otp-policy",
            icon: ShieldCheck,
          },
        ],
        helper: "For major lockdowns loop in a Super Admin before flipping switches.",
      },
    ],
  },
];

export default function AdminConsole() {
  const [activeSection, setActiveSection] = useState(SECTIONS[0].id);

  return (
    <div className="container mx-auto max-w-6xl p-6 space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs tracking-[0.4em] uppercase text-muted-foreground">Admin Workspace</p>
          <h1 className="text-3xl font-bold mt-1">Configuration Studio</h1>
          <p className="text-muted-foreground mt-2">
            Adjust content, staff directories, and notifications without diving into developer tooling.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-4">
          <div className="rounded-xl border bg-muted/30 p-4 sticky top-24">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-[0.3em] mb-3">
              Sections
            </p>
            <div className="flex flex-col gap-2">
              {SECTIONS.map((section) => (
                <Button
                  key={section.id}
                  variant={activeSection === section.id ? "default" : "ghost"}
                  className="justify-start"
                  onClick={() => setActiveSection(section.id)}
                >
                  {section.title}
                </Button>
              ))}
            </div>
          </div>
        </aside>

        <div className="space-y-6">
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
                  <TabsContent key={tab.id} value={tab.id}>
                    <Card>
                      <CardContent className="pt-6">
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
                        {tab.helper && (
                          <p className="mt-4 text-sm text-muted-foreground">{tab.helper}</p>
                        )}
                      </CardContent>
                    </Card>
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
