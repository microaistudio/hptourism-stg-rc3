import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Clock,
  CheckCircle,
  ArrowRight,
  Loader2,
  ClipboardCheck,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useLocation } from "wouter";
import { format, formatDistanceToNow, isThisMonth } from "date-fns";
import type { HomestayApplication, ApplicationKind } from "@shared/schema";
import { ApplicationKindBadge, getApplicationKindLabel, isServiceApplication } from "@/components/application/application-kind-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isCorrectionRequiredStatus } from "@/constants/workflow";
import { cn } from "@/lib/utils";

const isThisMonthSafe = (value?: string | Date | null) => {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(value);
  return isThisMonth(date);
};

interface ApplicationWithOwner extends HomestayApplication {
  ownerName: string;
  ownerMobile: string;
  daName?: string;
  latestCorrection?: {
    createdAt: string;
    feedback?: string | null;
  } | null;
}

type SortOrder = "newest" | "oldest";

type StagePillConfig = {
  value: string;
  label: string;
  count: number;
  description: string;
  applications: ApplicationWithOwner[];
  actionLabel: string | ((app: ApplicationWithOwner) => string);
  actionHint?: string | ((app: ApplicationWithOwner) => string | undefined);
  emptyTitle: string;
  emptyDescription: string;
};

type StageConfig = {
  key: string;
  title: string;
  description: string;
  icon: LucideIcon;
  pills: StagePillConfig[];
  totalCount?: number;
  actionCount?: number;
  actionLabel?: string;
};
export default function DTDODashboard() {
  const [activeStage, setActiveStage] = useState("new-queue");
  const [activePill, setActivePill] = useState("new-queue-forwarded");
  const [sortOrder, setSortOrder] = useState<SortOrder>("newest");
  const queryClient = useQueryClient();
  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/dtdo/applications"] });
    queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
  };
  
  const { data: applications, isLoading } = useQuery<ApplicationWithOwner[]>({
    queryKey: ["/api/dtdo/applications"],
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
  const currentUser = user?.user;

  // Group applications by status
  const forwardedByDA = useMemo(
    () => allApplications.filter((app) => app.status === "forwarded_to_dtdo"),
    [allApplications],
  );
  const paymentPending = useMemo(
    () =>
      allApplications.filter(
        (app) => app.status === "payment_pending" || app.status === "verified_for_payment",
      ),
    [allApplications],
  );
  const underReview = useMemo(
    () => allApplications.filter((app) => app.status === "dtdo_review"),
    [allApplications],
  );
  const inspectionPending = useMemo(
    () => allApplications.filter((app) => app.status === "inspection_scheduled"),
    [allApplications],
  );
  const inspectionReports = useMemo(
    () => allApplications.filter((app) => app.status === "inspection_under_review"),
    [allApplications],
  );
  const objectionQueue = useMemo(
    () =>
      allApplications.filter(
        (app) => app.status === "reverted_by_dtdo" || app.status === "objection_raised",
      ),
    [allApplications],
  );
  const awaitingOwner = useMemo(
    () => objectionQueue.filter((app) => !app.latestCorrection?.createdAt),
    [objectionQueue],
  );
  const ownerResubmitted = useMemo(
    () => objectionQueue.filter((app) => Boolean(app.latestCorrection?.createdAt)),
    [objectionQueue],
  );
  const approvedThisMonth = useMemo(
    () =>
      allApplications.filter(
        (app) => app.status === "approved" && isThisMonthSafe(app.approvedAt ?? app.updatedAt ?? null),
      ),
    [allApplications],
  );
  const daNewQueue = useMemo(
    () => allApplications.filter((app) => app.status === "submitted"),
    [allApplications],
  );
  const daNewRegistrations = useMemo(
    () =>
      daNewQueue.filter(
        (app) => !isServiceApplication(app.applicationKind as ApplicationKind | undefined),
      ),
    [daNewQueue],
  );
  const daServiceRequests = useMemo(
    () =>
      daNewQueue.filter((app) =>
        isServiceApplication(app.applicationKind as ApplicationKind | undefined),
      ),
    [daNewQueue],
  );
  const sortedDaNewRegistrations = useMemo(
    () => sortApplications(daNewRegistrations),
    [daNewRegistrations, sortApplications],
  );
  const sortedDaServiceRequests = useMemo(
    () => sortApplications(daServiceRequests),
    [daServiceRequests, sortApplications],
  );
  const rejectedThisMonth = useMemo(
    () =>
      allApplications.filter(
        (app) => app.status === "rejected" && isThisMonthSafe(app.updatedAt ?? app.approvedAt ?? null),
      ),
    [allApplications],
  );
  const newRegistrations = useMemo(
    () =>
      allApplications.filter(
        (app) => !isServiceApplication(app.applicationKind as ApplicationKind | undefined),
      ),
    [allApplications],
  );
  const serviceRequests = useMemo(
    () =>
      allApplications.filter((app) =>
        isServiceApplication(app.applicationKind as ApplicationKind | undefined),
      ),
    [allApplications],
  );
  const sortedForwarded = useMemo(() => sortApplications(forwardedByDA), [forwardedByDA, sortApplications]);
  const sortedUnderReview = useMemo(() => sortApplications(underReview), [underReview, sortApplications]);
  const sortedPaymentPending = useMemo(
    () => sortApplications(paymentPending),
    [paymentPending, sortApplications],
  );
  const sortedInspectionPending = useMemo(
    () => sortApplications(inspectionPending),
    [inspectionPending, sortApplications],
  );
  const sortedInspectionReports = useMemo(
    () => sortApplications(inspectionReports),
    [inspectionReports, sortApplications],
  );
  const sortedAwaitingOwner = useMemo(() => sortApplications(awaitingOwner), [awaitingOwner, sortApplications]);
  const sortedOwnerResubmitted = useMemo(
    () => sortApplications(ownerResubmitted),
    [ownerResubmitted, sortApplications],
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
        title: "New Queue (DTDO)",
        description: "Fresh submissions forwarded by DAs or reopened for DTDO action.",
        icon: FileText,
        actionCount: sortedForwarded.length + sortedPaymentPending.length,
        actionLabel: "Review forwards & unlock payments",
        pills: [
          {
            value: "new-queue-forwarded",
            label: "DA Forwards",
            count: sortedForwarded.length,
            description: "Cleared by dealing assistants and awaiting your review.",
            applications: sortedForwarded,
            actionLabel: "Start review",
            emptyTitle: "Nothing forwarded",
            emptyDescription: "DA will push files here once scrutiny is done.",
          },
          {
            value: "new-queue-review",
            label: "Under DTDO Review",
            count: sortedUnderReview.length,
            description: "Files you opened and can resume anytime.",
            applications: sortedUnderReview,
            actionLabel: "Resume review",
            emptyTitle: "No files in review",
            emptyDescription: "Open a forwarded application to begin review.",
          },
          {
            value: "new-queue-payments",
            label: "Payments Pending",
            count: sortedPaymentPending.length,
            description: "Owners awaiting payment verification or unlock.",
            applications: sortedPaymentPending,
            actionLabel: (app) =>
              app.status === "verified_for_payment" ? "Issue certificate" : "Monitor payment",
            actionHint: (app) =>
              app.status === "verified_for_payment"
                ? "Payment verified—generate certificate."
                : "Awaiting gateway confirmation.",
            emptyTitle: "No payments pending",
            emptyDescription: "Once owners pay, you'll see them here.",
          },
        ],
      },
      {
        key: "inspections",
        title: "Inspections",
        description: "Field work progress plus reports requiring DTDO sign-off.",
        icon: ClipboardCheck,
        actionCount: sortedInspectionReports.length,
        actionLabel: "Reports awaiting endorsement",
        totalCount: sortedInspectionPending.length + sortedInspectionReports.length,
        pills: [
          {
            value: "inspections-reports",
            label: "Reports",
            count: sortedInspectionReports.length,
            description: "Reports submitted and waiting for DTDO endorsement.",
            applications: sortedInspectionReports,
            actionLabel: "Review report",
            emptyTitle: "No reports pending",
            emptyDescription: "Completed inspections will appear here.",
          },
          {
            value: "inspections-scheduled",
            label: "Scheduled",
            count: sortedInspectionPending.length,
            description: "Inspection orders assigned and awaiting reports.",
            applications: sortedInspectionPending,
            actionLabel: "Manage inspection",
            emptyTitle: "No inspections scheduled",
            emptyDescription: "Schedule a visit once a case is ready.",
          },
        ],
      },
      {
        key: "corrections",
        title: "Pending / Corrections",
        description: "Files reverted to owners for clarifications.",
        icon: AlertCircle,
        actionCount: sortedOwnerResubmitted.length,
        actionLabel: "Awaiting DTDO confirmation",
        pills: [
          {
            value: "corrections-waiting",
            label: "Waiting Owner Response",
            count: sortedAwaitingOwner.length,
            description: "Owners still working on your objections.",
            applications: sortedAwaitingOwner,
            actionLabel: "Track objection",
            emptyTitle: "No owners pending",
            emptyDescription: "Every objection has been answered.",
          },
          {
            value: "corrections-resubmitted",
            label: "Resubmitted",
            count: sortedOwnerResubmitted.length,
            description: "Owners responded and await your confirmation.",
            applications: sortedOwnerResubmitted,
            actionLabel: "Verify resubmission",
            emptyTitle: "No resubmissions yet",
            emptyDescription: "You'll be notified as soon as owners respond.",
          },
        ],
      },
      {
        key: "closures",
        title: "Closed This Month",
        description: "Decisions finalized in the current month.",
        icon: CheckCircle,
        actionCount: sortedApprovedThisMonth.length,
        actionLabel: "Certificates issued",
        pills: [
          {
            value: "closures-approved",
            label: "Approved",
            count: sortedApprovedThisMonth.length,
            description: "Certificates issued in the current month.",
            applications: sortedApprovedThisMonth,
            actionLabel: "View certificate",
            emptyTitle: "No approvals yet",
            emptyDescription: "Finalize inspections to unlock approvals.",
          },
          {
            value: "closures-rejected",
            label: "Rejected",
            count: sortedRejectedThisMonth.length,
            description: "Applications declined this month.",
            applications: sortedRejectedThisMonth,
            actionLabel: "Review decision",
            emptyTitle: "No rejections",
            emptyDescription: "Declined files will show up here.",
          },
        ],
      },
      {
        key: "inflow",
        title: "New Queue (DA)",
        description: "Owner submissions waiting at the DA stage (for awareness).",
        icon: FileText,
        actionCount: sortedDaNewRegistrations.length,
        actionLabel: "Awareness only",
        pills: [
          {
            value: "inflow-new",
            label: "New Registration",
            count: sortedDaNewRegistrations.length,
            description: "Brand-new homestays currently with DAs.",
            applications: sortedDaNewRegistrations,
            actionLabel: "View details",
            emptyTitle: "No new registrations",
            emptyDescription: "DAs have no new registrations at the moment.",
          },
        ],
      },
    ],
    [
      sortedForwarded,
      sortedUnderReview,
      sortedInspectionPending,
      sortedInspectionReports,
      sortedAwaitingOwner,
      sortedOwnerResubmitted,
      sortedApprovedThisMonth,
      sortedRejectedThisMonth,
      sortedDaNewRegistrations,
      sortedDaServiceRequests,
      sortedPaymentPending,
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

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { label: string; className: string }> = {
      forwarded_to_dtdo: {
        label: "Forwarded by DA",
        className: "bg-blue-50 text-blue-700 dark:bg-blue-950/20",
      },
      dtdo_review: {
        label: "Under Review",
        className: "bg-orange-50 text-orange-700 dark:bg-orange-950/20",
      },
      inspection_scheduled: {
        label: "Inspection Scheduled",
        className: "bg-purple-50 text-purple-700 dark:bg-purple-950/20",
      },
      inspection_under_review: {
        label: "Report Awaiting Review",
        className: "bg-green-50 text-green-700 dark:bg-green-950/20",
      },
      payment_pending: {
        label: "Awaiting Payment",
        className: "bg-amber-50 text-amber-800 dark:bg-amber-950/20",
      },
      verified_for_payment: {
        label: "Payment Verified",
        className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20",
      },
      reverted_by_dtdo: {
        label: "Reverted to Applicant",
        className: "bg-rose-50 text-rose-700 dark:bg-rose-950/20",
      },
      objection_raised: {
        label: "DTDO Objection",
        className: "bg-rose-50 text-rose-700 dark:bg-rose-950/20",
      },
    };

    const config = statusConfig[status] || { label: status, className: "" };
    return <Badge variant="outline" className={config.className}>{config.label}</Badge>;
  };

  const getCorrectionState = (application: ApplicationWithOwner) => {
    if (!isCorrectionRequiredStatus(application.status)) {
      return null;
    }
    const resubmitted = Boolean(application.latestCorrection?.createdAt);
    const relative =
      resubmitted && application.latestCorrection?.createdAt
        ? formatDistanceToNow(new Date(application.latestCorrection.createdAt), { addSuffix: true })
        : null;
    return {
      label: resubmitted ? "Owner resubmitted" : "Waiting on owner",
      className: resubmitted
        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20"
        : "bg-amber-50 text-amber-700 dark:bg-amber-950/20",
      relative,
    };
  };

  const getCategoryBadge = (category: string) => {
    const colorMap: Record<string, string> = {
      diamond: "bg-purple-50 text-purple-700 dark:bg-purple-950/20",
      gold: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/20",
      silver: "bg-gray-50 text-gray-700 dark:bg-gray-950/20",
    };
    return (
      <Badge variant="outline" className={colorMap[category.toLowerCase()] || ""}>
        {category.toUpperCase()}
      </Badge>
    );
  };

  const ApplicationTable = ({ applications }: { applications: ApplicationWithOwner[] }) => {
    const [, navigate] = useLocation();
    const goToApplication = (appId: string, status?: string | null) => {
      const target =
        status === "inspection_under_review"
          ? `/dtdo/inspection-review/${appId}`
          : `/dtdo/applications/${appId}`;
      navigate(target);
    };

    const handleRowKeyDown = (
      event: KeyboardEvent<HTMLTableRowElement>,
      appId: string,
      status?: string | null,
    ) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        goToApplication(appId, status);
      }
    };

    return (
    <div className="border rounded-lg hidden md:block">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/50">
            <tr className="border-b">
              <th className="text-left p-4 font-medium">Application #</th>
              <th className="text-left p-4 font-medium">Property</th>
              <th className="text-left p-4 font-medium">Owner</th>
              <th className="text-left p-4 font-medium">Category</th>
              <th className="text-left p-4 font-medium">Location</th>
              <th className="text-left p-4 font-medium">Status</th>
              <th className="text-left p-4 font-medium">Corrections</th>
              <th className="text-left p-4 font-medium">Submitted</th>
              <th className="text-left p-4 font-medium">Updated</th>
              <th className="text-right p-4 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {applications.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center p-8 text-muted-foreground">
                  No applications found
                </td>
              </tr>
            ) : (
              applications.map((app) => {
                const status = app.status ?? "";
                const submittedAtDate = app.submittedAt ? new Date(app.submittedAt) : null;
                const appKind = app.applicationKind as ApplicationKind | undefined;
                const isService = isServiceApplication(appKind);
                const serviceLabel = getApplicationKindLabel(appKind);
                const correctionState = getCorrectionState(app);
                return (
                  <tr
                    key={app.id}
                    className="border-b hover-elevate cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => goToApplication(app.id, status)}
                    tabIndex={0}
                    onKeyDown={(event) => handleRowKeyDown(event, app.id, status)}
                    role="button"
                    aria-label={`Open application ${app.applicationNumber}`}
                  >
                  <td className="p-4">
                    <div className="font-medium">{app.applicationNumber}</div>
                    {app.daName && (
                      <div className="text-xs text-muted-foreground">
                        Forwarded by: {app.daName}
                      </div>
                    )}
                    <ApplicationKindBadge kind={appKind} className="mt-1" />
                  </td>
                  <td className="p-4">
                    <div className="font-medium">{app.propertyName}</div>
                    <div className="text-sm text-muted-foreground flex flex-wrap gap-2">
                      <span>{app.totalRooms} rooms</span>
                      {isService && (
                        <span>
                          {serviceLabel} • #{app.parentApplicationNumber || "—"}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <div>{app.ownerName}</div>
                    <div className="text-sm text-muted-foreground">{app.ownerMobile}</div>
                  </td>
                  <td className="p-4">{getCategoryBadge(app.category)}</td>
                  <td className="p-4">
                    <div>{app.tehsil || app.block || "Not Provided"}</div>
                    <div className="text-xs text-muted-foreground">{app.district}</div>
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {getStatusBadge(status)}
                      {correctionState && (
                        <Badge variant="outline" className={correctionState.className}>
                          {correctionState.label}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="font-medium">{app.correctionSubmissionCount ?? 0}</div>
                    {correctionState && (
                      <div className="text-xs text-muted-foreground mt-1">
                        {correctionState.relative || "Awaiting owner update"}
                      </div>
                    )}
                  </td>
                  <td className="p-4">
                    {submittedAtDate ? format(submittedAtDate, "MMM dd, yyyy") : "N/A"}
                  </td>
                  <td className="p-4">
                    {app.updatedAt ? format(new Date(app.updatedAt), "MMM dd, yyyy") : "N/A"}
                  </td>
                  <td className="p-4 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`button-review-${app.id}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        goToApplication(app.id, status);
                      }}
                    >
                      Review <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
  };

  const ApplicationCardList = ({ applications }: { applications: ApplicationWithOwner[] }) => {
    const [, navigate] = useLocation();
    const goToApplication = (appId: string, status?: string | null) => {
      const target =
        status === "inspection_under_review"
          ? `/dtdo/inspection-review/${appId}`
          : `/dtdo/applications/${appId}`;
      navigate(target);
    };

    const handleCardKeyDown = (
      event: KeyboardEvent<HTMLDivElement>,
      appId: string,
      status?: string | null,
    ) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        goToApplication(appId, status);
      }
    };

    return (
    <div className="space-y-4 md:hidden">
      {applications.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No applications found
        </div>
      ) : (
        applications.map((app) => {
          const status = app.status ?? "";
          const submittedAtDate = app.submittedAt ? new Date(app.submittedAt) : null;
          const appKind = app.applicationKind as ApplicationKind | undefined;
          const serviceLabel = getApplicationKindLabel(appKind);
          const isService = isServiceApplication(appKind);
          const correctionState = getCorrectionState(app);
          return (
            <div
              key={app.id}
              className="rounded-lg border p-4 shadow-sm space-y-3 cursor-pointer hover-elevate focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => goToApplication(app.id, status)}
              tabIndex={0}
              onKeyDown={(event) => handleCardKeyDown(event, app.id, status)}
              role="button"
              aria-label={`Open application ${app.applicationNumber}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">{app.applicationNumber}</p>
                  {isService && (
                    <p className="text-xs text-muted-foreground">
                      {serviceLabel} • #{app.parentApplicationNumber || "—"}
                    </p>
                  )}
                </div>
                <ApplicationKindBadge kind={appKind} />
              </div>
              <div className="space-y-1 text-sm">
                <p className="font-medium">{app.propertyName}</p>
                <p className="text-muted-foreground">
                  {app.totalRooms} rooms • {app.tehsil || app.block || "Location TBD"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {getCategoryBadge(app.category)}
                {getStatusBadge(status)}
                {correctionState && (
                  <Badge variant="outline" className={correctionState.className}>
                    {correctionState.label}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p>
                  Submitted {submittedAtDate ? format(submittedAtDate, "MMM dd, yyyy") : "N/A"}
                  {" · Corrections: "}{app.correctionSubmissionCount ?? 0}
                </p>
                {correctionState && (
                  <p>{correctionState.relative || "Awaiting owner update"}</p>
                )}
              </div>
              <Button
                className="w-full"
                size="sm"
                variant="secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  goToApplication(app.id, status);
                }}
              >
                Review application
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
  };

  const QueueSection = ({
    title,
    description,
    applications,
    actionLabel,
    actionHint,
    emptyState,
    headerExtras,
  }: {
    title: string;
    description: string;
    applications: ApplicationWithOwner[];
    actionLabel: string | ((application: ApplicationWithOwner) => string);
    actionHint?: string | ((application: ApplicationWithOwner) => string | undefined);
    emptyState: {
      icon: LucideIcon;
      title: string;
      description: string;
    };
    headerExtras?: ReactNode;
  }) => {
    const EmptyIcon = emptyState.icon;
    const resolveActionLabel =
      typeof actionLabel === "function" ? actionLabel : () => actionLabel;
    const hasActionHint = typeof actionHint !== "undefined";
    const resolveActionHint =
      typeof actionHint === "function"
        ? actionHint
        : () => (typeof actionHint === "string" ? actionHint : undefined);

    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
          {headerExtras}
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <EmptyIcon className="w-10 h-10 mx-auto mb-4 opacity-50" />
              <p className="font-medium text-foreground">{emptyState.title}</p>
              <p className="text-sm text-muted-foreground mt-1">{emptyState.description}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {applications.map((app) => (
                <QueueCard
                  key={app.id}
                  application={app}
                  actionLabel={resolveActionLabel(app)}
                  actionHint={hasActionHint ? resolveActionHint(app) : undefined}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const QueueCard = ({
    application,
    actionLabel,
    actionHint,
  }: {
    application: ApplicationWithOwner;
    actionLabel: string | ((application: ApplicationWithOwner) => string);
    actionHint?: string | ((application: ApplicationWithOwner) => string | undefined);
  }) => {
    const applicationKind = application.applicationKind as ApplicationKind | undefined;
    const isService = isServiceApplication(applicationKind);
    const serviceLabel = getApplicationKindLabel(applicationKind);
    const [, navigate] = useLocation();
    const status = application.status ?? "";
    const correctionState = getCorrectionState(application);
    const submittedOn = application.submittedAt ? format(new Date(application.submittedAt), "MMM dd, yyyy") : "N/A";
    const updatedOn = application.updatedAt ? format(new Date(application.updatedAt), "MMM dd, yyyy") : "N/A";
    const updatedRelative = application.updatedAt
      ? formatDistanceToNow(new Date(application.updatedAt), { addSuffix: true })
      : null;
    const reviewPath =
      status === "inspection_under_review"
        ? `/dtdo/inspection-review/${application.id}`
        : `/dtdo/applications/${application.id}`;
    const handleNavigate = () => navigate(reviewPath);
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleNavigate();
      }
    };

    const resolvedActionLabel = typeof actionLabel === "function" ? actionLabel(application) : actionLabel;
    const resolvedActionHint =
      typeof actionHint === "function" ? actionHint(application) : actionHint ?? undefined;

    return (
      <div
        className="p-4 border rounded-lg hover-elevate cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        role="button"
        tabIndex={0}
        onClick={handleNavigate}
        onKeyDown={handleKeyDown}
        aria-label={`Open application ${application.applicationNumber}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span>Application #{application.applicationNumber}</span>
          {application.daName && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700 dark:bg-blue-950/20 dark:text-blue-100">
              Forwarded by {application.daName}
            </span>
          )}
          <ApplicationKindBadge kind={applicationKind} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h3 className="text-lg font-semibold leading-tight">{application.propertyName}</h3>
          {getCategoryBadge(application.category)}
          {getStatusBadge(status)}
          {correctionState && (
            <Badge variant="outline" className={correctionState.className}>
              {correctionState.label}
            </Badge>
          )}
          {(application.correctionSubmissionCount ?? 0) > 0 && (
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
              Cycle {application.correctionSubmissionCount}
            </Badge>
          )}
        </div>
        <div className="mt-3 grid gap-3 text-sm text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className="font-medium text-foreground">Owner:</span> {application.ownerName}
          </div>
          <div>
            <span className="font-medium text-foreground">Mobile:</span> {application.ownerMobile}
          </div>
          <div>
            <span className="font-medium text-foreground">Location:</span>{" "}
            {application.tehsil || application.block || "Not provided"}, {application.district}
          </div>
          <div>
            <span className="font-medium text-foreground">Rooms:</span> {application.totalRooms}
          </div>
          <div>
            <span className="font-medium text-foreground">Submitted:</span> {submittedOn}
          </div>
          <div>
            <span className="font-medium text-foreground">Updated:</span> {updatedOn}
            {updatedRelative && (
              <span className="ml-1 text-xs text-muted-foreground">({updatedRelative})</span>
            )}
          </div>
        </div>
        {correctionState?.relative && (
          <div className="mt-2 text-xs text-muted-foreground">
            {correctionState.relative}
          </div>
        )}
        {isService && (
          <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span>Service: {serviceLabel}</span>
            <span>Parent App: {application.parentApplicationNumber || "—"}</span>
            <span>
              Certificate #: {application.parentCertificateNumber || application.certificateNumber || "—"}
            </span>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {updatedRelative ? `Updated ${updatedRelative}` : "Awaiting next update"}
          </div>
          <Button
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              handleNavigate();
            }}
          >
            {resolvedActionLabel}
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
        {resolvedActionHint && (
          <p className="text-xs text-muted-foreground mt-1">{resolvedActionHint}</p>
        )}
      </div>
    );
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">DTDO Dashboard</h1>
          <p className="text-muted-foreground mt-2">
            {currentUser?.district ? `District: ${currentUser.district}` : "Review and process homestay applications"}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleRefresh}
          data-testid="button-dtdo-refresh"
          className="w-fit"
        >
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {stageConfigs.map((stage) => {
          const Icon = stage.icon;
          const totalCount = stage.totalCount ?? stage.pills.reduce((sum, pill) => sum + pill.count, 0);
          const actionableCount = stage.actionCount ?? totalCount;
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
                  <p className="text-3xl font-semibold mt-1">{actionableCount}</p>
                  {stage.actionLabel && (
                    <p className="text-[11px] text-muted-foreground mt-1">{stage.actionLabel}</p>
                  )}
                  {totalCount !== actionableCount && (
                    <p className="text-[11px] text-muted-foreground mt-1">Overall queue: {totalCount}</p>
                  )}
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
        <div className="flex flex-wrap gap-2 bg-muted/30 p-3 rounded-3xl">
          {activeStageConfig.pills.map((pill) => {
            const isActivePill = pill.value === activePillConfig?.value;
            return (
              <button
                key={pill.value}
                type="button"
                className={cn(
                  "px-4 py-1.5 rounded-full border text-sm font-semibold flex items-center gap-2 transition-colors",
                  isActivePill
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-white text-foreground border-border hover:bg-muted",
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
              </button>
            );
          })}
        </div>
      )}

      {activeStageConfig && activePillConfig && (
        <Card data-testid={`stage-${activeStageConfig.key}-${activePillConfig.value}`}>
          <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>{activePillConfig.label}</CardTitle>
              <CardDescription>{activePillConfig.description}</CardDescription>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Sort:</span>
              <Select value={sortOrder} onValueChange={(value: SortOrder) => setSortOrder(value)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder="Sort order" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {activePillConfig.applications.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border rounded-lg">
                <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p className="font-medium">{activePillConfig.emptyTitle}</p>
                <p className="text-sm mt-1">{activePillConfig.emptyDescription}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {activePillConfig.applications.map((application) => (
                  <QueueCard
                    key={application.id}
                    application={application}
                    actionLabel={activePillConfig.actionLabel ?? "Open application"}
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
