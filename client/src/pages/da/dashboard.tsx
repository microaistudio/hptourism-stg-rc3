import { useCallback, useEffect, useMemo, useState } from "react";
import { isThisMonth } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  FileText,
  CheckCircle,
  AlertCircle,
  Search,
  Loader2,
  RefreshCw,
  BellRing,
  type LucideIcon,
} from "lucide-react";
import { useLocation } from "wouter";
import type { HomestayApplication, ApplicationKind } from "@shared/schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isCorrectionRequiredStatus } from "@/constants/workflow";
import { cn } from "@/lib/utils";
import {
  ApplicationPipelineRow,
  type PipelineApplication,
} from "@/components/application/application-pipeline-row";
import { isServiceApplication } from "@/components/application/application-kind-badge";

const isInCurrentMonth = (value?: string | null) => {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return isThisMonth(date);
};
type ApplicationWithOwner = PipelineApplication;

type InspectionSummary = {
  id: string;
  reportSubmitted: boolean;
  status: string;
  inspectionDate?: string | null;
  updatedAt?: string | null;
};

type SortOrder = "newest" | "oldest";

export default function DADashboard() {
  const [activeStage, setActiveStage] = useState("new-queue");
  const [activePill, setActivePill] = useState("new-queue-new");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/da/applications"] });
    queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    queryClient.invalidateQueries({ queryKey: ["/api/da/inspections"] });
  };
  const navigateToInspections = useCallback(() => {
    setLocation("/da/inspections");
  }, [setLocation]);
  
  const { data: applications, isLoading } = useQuery<ApplicationWithOwner[]>({
    queryKey: ["/api/da/applications"],
  });

  const allApplications = applications ?? [];

  const getSortTimestamp = useCallback((app: ApplicationWithOwner) => {
    const candidate = app.updatedAt ?? app.submittedAt ?? app.createdAt;
    return candidate ? new Date(candidate).getTime() : 0;
  }, []);

  const sortApplications = useCallback(
    (apps: ApplicationWithOwner[]) =>
      [...apps].sort((a, b) => {
        const diff = getSortTimestamp(a) - getSortTimestamp(b);
        return sortOrder === "newest" ? -diff : diff;
      }),
    [getSortTimestamp, sortOrder],
  );

  const { data: user } = useQuery<{ user: { id: string; fullName: string; role: string; district?: string } }>({
    queryKey: ["/api/auth/me"],
  });
  const { data: inspections } = useQuery<InspectionSummary[]>({
    queryKey: ["/api/da/inspections"],
  });

  // Group applications by status
  const submittedApplications = useMemo(
    () => allApplications.filter((app) => app.status === "submitted"),
    [allApplications],
  );
  const underScrutiny = useMemo(
    () => allApplications.filter((app) => app.status === "under_scrutiny"),
    [allApplications],
  );
  const forwarded = useMemo(
    () => allApplications.filter((app) => app.status === "forwarded_to_dtdo"),
    [allApplications],
  );
  const reverted = useMemo(
    () => allApplications.filter((app) => isCorrectionRequiredStatus(app.status)),
    [allApplications],
  );
  const awaitingOwner = useMemo(
    () => reverted.filter((app) => !app.latestCorrection?.createdAt),
    [reverted],
  );
  const ownerResubmitted = useMemo(
    () => reverted.filter((app) => Boolean(app.latestCorrection?.createdAt)),
    [reverted],
  );
  const serviceRegistrationQueue = useMemo(
    () =>
      submittedApplications.filter((app) =>
        isServiceApplication(app.applicationKind as ApplicationKind | undefined),
      ),
    [submittedApplications],
  );
  const newRegistrationQueue = useMemo(
    () =>
      submittedApplications.filter(
        (app) => !isServiceApplication(app.applicationKind as ApplicationKind | undefined),
      ),
    [submittedApplications],
  );
  const sortedServiceRegistrationQueue = useMemo(
    () => sortApplications(serviceRegistrationQueue),
    [serviceRegistrationQueue, sortApplications],
  );
  const sortedNewRegistrationQueue = useMemo(
    () => sortApplications(newRegistrationQueue),
    [newRegistrationQueue, sortApplications],
  );
  const sortedUnderScrutiny = useMemo(
    () => sortApplications(underScrutiny),
    [underScrutiny, sortApplications],
  );
  const sortedForwarded = useMemo(() => sortApplications(forwarded), [forwarded, sortApplications]);
  const sortedAwaitingOwners = useMemo(() => sortApplications(awaitingOwner), [awaitingOwner, sortApplications]);
  const sortedResubmitted = useMemo(
    () => sortApplications(ownerResubmitted),
    [ownerResubmitted, sortApplications],
  );
  const scheduledInspections = useMemo(
    () => (inspections ?? []).filter((order) => !order.reportSubmitted),
    [inspections],
  );
  const completedInspections = useMemo(
    () => (inspections ?? []).filter((order) => order.reportSubmitted),
    [inspections],
  );
  const completedInspectionsThisMonth = useMemo(
    () =>
      completedInspections.filter((order) =>
        isInCurrentMonth(order.updatedAt || order.inspectionDate || null),
      ),
    [completedInspections],
  );
  const approvedThisMonth = useMemo(
    () =>
      allApplications.filter(
        (app) => app.status === "approved" && isInCurrentMonth(app.approvedAt ?? app.updatedAt),
      ),
    [allApplications],
  );
  const rejectedThisMonth = useMemo(
    () =>
      allApplications.filter((app) => app.status === "rejected" && isInCurrentMonth(app.updatedAt)),
    [allApplications],
  );
  const sortedApprovedThisMonth = useMemo(
    () => sortApplications(approvedThisMonth),
    [approvedThisMonth, sortApplications],
  );
  const sortedRejectedThisMonth = useMemo(
    () => sortApplications(rejectedThisMonth),
    [rejectedThisMonth, sortApplications],
  );
  const stageConfigs = useMemo<StageConfig[]>(
    () => [
      {
        key: "new-queue",
        title: "New Queue (DA)",
        description: "Fresh submissions waiting for you to start scrutiny.",
        icon: FileText,
        pills: [
          {
            value: "new-queue-new",
            label: "New Registration",
            count: sortedNewRegistrationQueue.length,
            description: "Brand-new properties seeking recognition.",
            applications: sortedNewRegistrationQueue,
            actionLabel: "Start scrutiny",
            emptyTitle: "No new registrations",
            emptyDescription: "Every new application has been triaged.",
          },
          {
            value: "new-queue-service",
            label: "Current License Holders",
            count: sortedServiceRegistrationQueue.length,
            description: "Renewals or service requests from existing licensees.",
            applications: sortedServiceRegistrationQueue,
            actionLabel: "Review request",
            emptyTitle: "No service requests",
            emptyDescription: "No existing licensee is waiting to be reviewed.",
          },
        ],
      },
      {
        key: "screening",
        title: "Screening Process",
        description: "Files currently going through your scrutiny flow.",
        icon: Search,
        pills: [
          {
            value: "screening-under",
            label: "Under Scrutiny",
            count: sortedUnderScrutiny.length,
            description: "Applications you're actively reviewing.",
            applications: sortedUnderScrutiny,
            actionLabel: "Resume review",
            emptyTitle: "No files in scrutiny",
            emptyDescription: "Pick any pending application to keep the queue moving.",
          },
          {
            value: "screening-forwarded",
            label: "Forwarded to DTDO",
            count: sortedForwarded.length,
            description: "Cases awaiting DTDO action. Keep an eye on responses.",
            applications: sortedForwarded,
            actionLabel: "View summary",
            emptyTitle: "Nothing forwarded yet",
            emptyDescription: "Forward files once all DA checks are complete.",
          },
        ],
      },
      {
        key: "corrections",
        title: "Pending / Corrections",
        description: "Owner clarifications and resubmissions that need follow-up.",
        icon: AlertCircle,
        pills: [
          {
            value: "corrections-waiting",
            label: "Waiting on Owner",
            count: sortedAwaitingOwners.length,
            description: "Corrections requested and awaiting owner response.",
            applications: sortedAwaitingOwners,
            actionLabel: "Review notes",
            emptyTitle: "No pending owners",
            emptyDescription: "All requested corrections have been acknowledged.",
          },
          {
            value: "corrections-resubmitted",
            label: "Resubmitted",
            count: sortedResubmitted.length,
            description: "Owners have shared updates and await your confirmation.",
            applications: sortedResubmitted,
            actionLabel: "Review update",
            emptyTitle: "No new resubmissions",
            emptyDescription: "You'll be notified when an owner sends corrections.",
          },
        ],
      },
      {
        key: "inspections",
        title: "Inspections",
        description: "Status of field inspections assigned to you.",
        icon: BellRing,
        totalCount: scheduledInspections.length,
        pills: [
          {
            value: "inspections-scheduled",
            label: "Scheduled",
            count: scheduledInspections.length,
            description: "Visits assigned but awaiting field report uploads.",
            applications: [],
            emptyTitle: "All inspections cleared",
            emptyDescription: "You don't have any pending field visits.",
            render: () => (
              <InspectionSummaryCard
                count={scheduledInspections.length}
                variant="pending"
                onNavigate={navigateToInspections}
              />
            ),
          },
          {
            value: "inspections-completed",
            label: "Completed This Month",
            count: completedInspectionsThisMonth.length,
            description: "Reports submitted in the current month.",
            applications: [],
            emptyTitle: "No recent inspections",
            emptyDescription: "Completed inspections will appear here.",
            render: () => (
              <InspectionSummaryCard
                count={completedInspectionsThisMonth.length}
                variant="completed"
                onNavigate={navigateToInspections}
                subtitle="Reports filed in the current month."
              />
            ),
          },
        ],
      },
      {
        key: "closures",
        title: "Closed This Month",
        description: "Decisions recorded in the current month.",
        icon: CheckCircle,
        pills: [
          {
            value: "closures-approved",
            label: "Approved",
            count: sortedApprovedThisMonth.length,
            description: "Applications that cleared all checks this month.",
            applications: sortedApprovedThisMonth,
            actionLabel: "View certificate",
            emptyTitle: "No approvals yet",
            emptyDescription: "Complete scrutiny + inspection to unlock approvals.",
          },
          {
            value: "closures-rejected",
            label: "Rejected",
            count: sortedRejectedThisMonth.length,
            description: "Applications declined during this month.",
            applications: sortedRejectedThisMonth,
            actionLabel: "Review decision",
            emptyTitle: "No rejections",
            emptyDescription: "Declined files in the current month will appear here.",
          },
        ],
      },
    ],
    [
      sortedNewRegistrationQueue,
      sortedServiceRegistrationQueue,
      sortedUnderScrutiny,
      sortedForwarded,
      sortedAwaitingOwners,
      sortedResubmitted,
      scheduledInspections,
      completedInspectionsThisMonth,
      sortedApprovedThisMonth,
      sortedRejectedThisMonth,
      navigateToInspections,
    ],
  );
  useEffect(() => {
    if (!stageConfigs.length) return;
    const resolvedStage = stageConfigs.find((stage) => stage.key === activeStage) ?? stageConfigs[0];
    if (resolvedStage.key !== activeStage) {
      setActiveStage(resolvedStage.key);
      setActivePill(resolvedStage.pills[0]?.value ?? "");
      return;
    }
    if (!resolvedStage.pills.length) return;
    const resolvedPill =
      resolvedStage.pills.find((pill) => pill.value === activePill) ?? resolvedStage.pills[0];
    if (resolvedPill.value !== activePill) {
      setActivePill(resolvedPill.value);
    }
  }, [stageConfigs, activeStage, activePill]);
  const activeStageConfig =
    stageConfigs.find((stage) => stage.key === activeStage) ?? stageConfigs[0];
  const activePillConfig =
    activeStageConfig?.pills.find((pill) => pill.value === activePill) ??
    activeStageConfig?.pills[0];

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 max-w-7xl">
        <div className="flex items-center justify-center h-96">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      {/* Header */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold mb-2">Dealing Assistant Dashboard</h1>
          <p className="text-muted-foreground">
            {user?.user?.district || 'District'} - Application Scrutiny & Verification
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleRefresh}
          data-testid="button-da-refresh"
          className="w-fit"
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Stage Overview */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5 mb-6">
        {stageConfigs.map((stage) => {
          const Icon = stage.icon;
          const totalCount = stage.totalCount ?? stage.pills.reduce((sum, pill) => sum + pill.count, 0);
          const isActiveStage = stage.key === activeStageConfig?.key;
          return (
            <Card
              key={stage.key}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (stage.key !== activeStage) {
                  setActiveStage(stage.key);
                  setActivePill(stage.pills[0]?.value ?? "");
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (stage.key !== activeStage) {
                    setActiveStage(stage.key);
                    setActivePill(stage.pills[0]?.value ?? "");
                  }
                }
              }}
              className={cn(
                "p-5 flex flex-col gap-3 cursor-pointer transition-all border border-border hover-elevate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-2xl",
                isActiveStage ? "ring-2 ring-primary" : "",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">{stage.title}</p>
                  <p className="text-3xl font-semibold mt-1">{totalCount}</p>
                </div>
                <div className="p-2 rounded-full bg-muted/40">
                  <Icon className="w-5 h-5 text-primary" />
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-1">{stage.description}</p>
            </Card>
          );
        })}
      </div>

      {activeStageConfig && (
        <div className="flex flex-wrap gap-2 bg-muted/30 p-3 rounded-3xl mb-6">
          {activeStageConfig.pills.map((pill) => {
            const isActivePill = pill.value === activePillConfig?.value;
            const isAttentionPill =
              (pill.value === "corrections-waiting" || pill.value === "corrections-resubmitted") && pill.count > 0;
            return (
              <button
                key={pill.value}
                type="button"
                className={cn(
                  "px-4 py-1.5 rounded-full border text-sm font-semibold flex items-center gap-2 transition-colors",
                  isActivePill
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-white text-foreground border-border hover:bg-muted"
                )}
                onClick={() => {
                  setActiveStage(activeStageConfig.key);
                  setActivePill(pill.value);
                }}
              >
                <span>{pill.label}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
                  {pill.count}
                </span>
                {isAttentionPill && !isActivePill && <span className="h-2 w-2 rounded-full bg-amber-500" />}
              </button>
            );
          })}
        </div>
      )}

      {scheduledInspections.length > 0 && (
        <div className="mb-8 rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-800">Inspections need attention</p>
            <p className="text-sm text-amber-900/80">
              {scheduledInspections.length} inspection{scheduledInspections.length === 1 ? "" : "s"} are awaiting field
              reports.
            </p>
          </div>
          <Button
            variant="outline"
            className="border-amber-300 text-amber-900 hover:bg-amber-100"
            onClick={navigateToInspections}
          >
            <BellRing className="w-4 h-4 mr-2" />
            View inspection queue
          </Button>
        </div>
      )}

      {activeStageConfig && activePillConfig && (
        <Card data-testid={`stage-${activeStageConfig.key}-${activePillConfig.value}`}>
          <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>{activePillConfig.label}</CardTitle>
              <CardDescription>{activePillConfig.description}</CardDescription>
            </div>
            {!activePillConfig.render && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Sort</span>
                <Select value={sortOrder} onValueChange={(value: SortOrder) => setSortOrder(value)}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue placeholder="Sort order" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {activePillConfig.render ? (
              activePillConfig.render(activePillConfig.applications)
            ) : activePillConfig.applications.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border rounded-lg">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p className="font-medium">{activePillConfig.emptyTitle}</p>
                <p className="text-sm mt-1">{activePillConfig.emptyDescription}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {activePillConfig.applications.map((application) => (
                  <ApplicationPipelineRow
                    key={application.id}
                    application={application}
                    actionLabel={activePillConfig.actionLabel ?? "Open application"}
                    applicationIds={activePillConfig.applications.map((a) => a.id)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface StageConfig {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  totalCount?: number;
  pills: StagePillConfig[];
}

interface StagePillConfig {
  value: string;
  label: string;
  count: number;
  description: string;
  applications: ApplicationWithOwner[];
  actionLabel?: string;
  emptyTitle: string;
  emptyDescription: string;
  render?: (applications: ApplicationWithOwner[]) => JSX.Element;
}

interface InspectionSummaryCardProps {
  count: number;
  variant: "pending" | "completed";
  onNavigate: () => void;
  subtitle?: string;
}

function InspectionSummaryCard({ count, variant, onNavigate, subtitle }: InspectionSummaryCardProps) {
  const isPending = variant === "pending";
  const title = isPending ? "Scheduled inspections" : "Completed inspections";
  const description = subtitle
    ? subtitle
    : isPending
      ? "Field visits are scheduled and waiting for updates."
      : "These inspections already include submitted reports.";
  const buttonLabel = isPending ? "Capture inspection updates" : "View inspection history";

  return (
    <div className="text-center py-8 space-y-4">
      <div className="space-y-1">
        <p className="text-sm uppercase tracking-wide text-muted-foreground">{title}</p>
        <p className="text-4xl font-semibold">{count}</p>
        <p className="text-muted-foreground">{description}</p>
      </div>
      <Button onClick={onNavigate} variant={isPending ? "default" : "outline"} className="gap-2">
        {buttonLabel}
      </Button>
    </div>
  );
}
