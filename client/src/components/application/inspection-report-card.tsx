import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ClipboardCheck, Download, FileWarning, Info, Printer } from "lucide-react";
import { DESIRABLE_TOTAL, MANDATORY_TOTAL } from "@/constants/inspection";
import { buildObjectViewUrl, cn } from "@/lib/utils";
import { fetchInspectionReportSummary, type InspectionReportSummary } from "@/lib/inspection-report";
import { generateInspectionReportPdf } from "@/lib/inspectionReportPdf";

const outcomeBadge = (outcome?: string | null) => {
  if (!outcome) {
    return { label: "Pending", className: "bg-muted text-muted-foreground" };
  }
  switch (outcome.toLowerCase()) {
    case "recommended":
    case "approved":
      return { label: "Recommended", className: "bg-emerald-50 text-emerald-800" };
    case "objection":
    case "raise_objections":
      return { label: "Objection Raised", className: "bg-amber-50 text-amber-900" };
    case "rejected":
      return { label: "Rejected", className: "bg-rose-50 text-rose-700" };
    default:
      return { label: outcome.replace(/_/g, " "), className: "bg-muted text-muted-foreground" };
  }
};

export function InspectionReportCard({
  applicationId,
  className,
  preferDtdoEndpoint = false,
}: {
  applicationId?: string | null;
  className?: string;
  preferDtdoEndpoint?: boolean;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/applications", applicationId ?? "unknown", "inspection-report"],
    enabled: Boolean(applicationId),
    queryFn: () => fetchInspectionReportSummary(applicationId!, preferDtdoEndpoint),
  });

  const mandatoryProgress = useMemo(() => {
    if (!data?.report?.mandatoryChecklist) return 0;
    const values = Object.values(data.report.mandatoryChecklist as Record<string, boolean>);
    if (values.length === 0) return 0;
    return (values.filter(Boolean).length / MANDATORY_TOTAL) * 100;
  }, [data]);

  const desirableProgress = useMemo(() => {
    if (!data?.report?.desirableChecklist) return 0;
    const values = Object.values(data.report.desirableChecklist as Record<string, boolean>);
    if (values.length === 0) return 0;
    return (values.filter(Boolean).length / DESIRABLE_TOTAL) * 100;
  }, [data]);

  if (!applicationId) {
    return null;
  }

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="space-y-4">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      );
    }

    if (error) {
      return (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      );
    }

    if (!data) {
      return (
        <div className="flex flex-col items-start gap-3">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Info className="h-5 w-5" />
            <p className="text-sm">Inspection report will be available once the DA submits it from the field.</p>
          </div>
        </div>
      );
    }

    const { report, inspectionOrder, da, dtdo, application } = data;
    const outcome = outcomeBadge(application.siteInspectionOutcome || report.recommendation);
    const actualDate = report.actualInspectionDate ? format(new Date(report.actualInspectionDate), "PPP") : null;
    const submittedDate = report.submittedDate ? format(new Date(report.submittedDate), "PPP") : null;
    const mandatoryCompleted = Math.round((mandatoryProgress / 100) * MANDATORY_TOTAL);
    const desirableCompleted = Math.round((desirableProgress / 100) * DESIRABLE_TOTAL);

    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge className={cn("flex items-center gap-2", outcome.className)}>
            <ClipboardCheck className="h-4 w-4" /> {outcome.label}
          </Badge>
          {actualDate && (
            <span className="text-sm text-muted-foreground">Inspected on {actualDate}</span>
          )}
          {submittedDate && (
            <span className="text-sm text-muted-foreground">· Report filed {submittedDate}</span>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Mandatory compliance</p>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{mandatoryCompleted}/{MANDATORY_TOTAL} checkpoints</span>
              <span>{Math.round(mandatoryProgress)}%</span>
            </div>
            <Progress value={mandatoryProgress} className="h-2" />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Desirable facilities</p>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{desirableCompleted}/{DESIRABLE_TOTAL} checkpoints</span>
              <span>{Math.round(desirableProgress)}%</span>
            </div>
            <Progress value={desirableProgress} className="h-2 bg-muted" />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border bg-muted/20 p-3 text-sm">
            <p className="text-muted-foreground">Assigned officer</p>
            <p className="font-medium">{da?.fullName ?? "—"}</p>
            {inspectionOrder?.inspectionDate && (
              <p className="text-xs text-muted-foreground">
                Scheduled for {format(new Date(inspectionOrder.inspectionDate), "PPP")}
              </p>
            )}
          </div>
          <div className="rounded-lg border bg-muted/20 p-3 text-sm">
            <p className="text-muted-foreground">DTDO</p>
            <p className="font-medium">{dtdo?.fullName ?? "—"}</p>
            {inspectionOrder?.specialInstructions && (
              <p className="text-xs text-muted-foreground mt-1">
                Notes: {inspectionOrder.specialInstructions}
              </p>
            )}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium mb-1">Summary</p>
          <p className="rounded-lg border bg-muted/10 p-3 text-sm whitespace-pre-line">
            {report.detailedFindings || "No remarks recorded."}
          </p>
        </div>

        <div className="flex gap-3 flex-wrap">
          {report.reportDocumentUrl ? (
            <Button variant="outline" asChild>
              <a href={buildObjectViewUrl(report.reportDocumentUrl)} target="_blank" rel="noreferrer">
                <Download className="mr-2 h-4 w-4" /> Download PDF
              </a>
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => generateInspectionReportPdf(data)}
              data-testid="button-generate-inspection-pdf"
            >
              <Download className="mr-2 h-4 w-4" /> Download Snapshot
            </Button>
          )}
          <Button variant="ghost" onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" /> Print view
          </Button>
        </div>

        {application.siteInspectionNotes && (
          <Alert>
            <FileWarning className="h-4 w-4" />
            <AlertDescription>{application.siteInspectionNotes}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  };

  return (
    <Card className={className} data-testid="inspection-report-card">
      <CardHeader>
        <CardTitle>Inspection Report</CardTitle>
        <CardDescription>Snapshot of the latest field inspection submitted by the DA.</CardDescription>
      </CardHeader>
      <CardContent>{renderContent()}</CardContent>
    </Card>
  );
}
