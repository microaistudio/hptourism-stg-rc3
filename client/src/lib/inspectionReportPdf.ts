import jsPDFImport from "jspdf";
import { format } from "date-fns";
import hpGovLogo from "@/assets/logos_tr/HP_Gov_TR.png?inline";
import hpTourismLogo from "@/assets/logos_tr/HP_Touris_TR.png?inline";
import { DESIRABLE_TOTAL, MANDATORY_TOTAL } from "@/constants/inspection";
import type { InspectionReportSummary } from "./inspection-report";

const jsPDF = (jsPDFImport as any).jsPDF || jsPDFImport;
type JsPDFInstance = any;

type LogoSpec = {
  width: number;
  x: number;
};

const LOGO_SPECS: LogoSpec[] = [
  { width: 28, x: 20 },
  { width: 32, x: 160 },
];

const formatDate = (value?: string | Date | null) => {
  if (!value) return "—";
  const parsed = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(parsed?.getTime?.())) {
    return "—";
  }
  return format(parsed, "PPP");
};

export function generateInspectionReportPdf(summary: InspectionReportSummary) {
  const doc: JsPDFInstance = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  drawHeader(doc, summary);
  drawBody(doc, summary);
  const fileName = `Inspection_Report_${summary.application.applicationNumber}.pdf`;
  doc.save(fileName);
}

function drawHeader(doc: JsPDFInstance, summary: InspectionReportSummary) {
  doc.setFont("times", "bold");
  doc.setFontSize(14);
  doc.text("HP Tourism & Civil Aviation Department", 105, 18, { align: "center" });
  doc.setFontSize(11);
  doc.text("District Inspection Report", 105, 26, { align: "center" });

  const pageHeight = doc.internal.pageSize.getHeight();
  const logoY = 30;
  const govHeight = LOGO_SPECS[0].width * (hpGovLogo.height / hpGovLogo.width || 0.9);
  const tourismHeight = LOGO_SPECS[1].width * (hpTourismLogo.height / hpTourismLogo.width || 0.9);

  doc.addImage(hpGovLogo, "PNG", LOGO_SPECS[0].x, logoY, LOGO_SPECS[0].width, govHeight);
  doc.addImage(hpTourismLogo, "PNG", LOGO_SPECS[1].x, logoY, LOGO_SPECS[1].width, tourismHeight);

  doc.setLineWidth(0.3);
  doc.line(20, logoY + Math.max(govHeight, tourismHeight) + 8, 190, logoY + Math.max(govHeight, tourismHeight) + 8);
  doc.setFont("times", "normal");
  doc.setFontSize(10);
  doc.text(
    `Application No.: ${summary.application.applicationNumber} \nProperty: ${summary.application.propertyName}`,
    20,
    logoY + Math.max(govHeight, tourismHeight) + 16,
  );
  doc.text(
    `District: ${summary.application.district}  ·  Tehsil: ${summary.application.tehsil}`,
    20,
    logoY + Math.max(govHeight, tourismHeight) + 24,
  );
  doc.text(
    `Outcome: ${(summary.application.siteInspectionOutcome || summary.report.recommendation || "Pending").replace(/_/g, " ")}`,
    20,
    logoY + Math.max(govHeight, tourismHeight) + 32,
  );
  doc.text(
    `Inspection Date: ${formatDate(summary.report.actualInspectionDate)}  ·  Submitted: ${formatDate(summary.report.submittedDate)}`,
    20,
    logoY + Math.max(govHeight, tourismHeight) + 40,
  );

  doc.text(`DA: ${summary.da?.fullName ?? "—"}`, 20, logoY + Math.max(govHeight, tourismHeight) + 48);
  if (summary.dtdo?.fullName) {
    doc.text(`DTDO: ${summary.dtdo.fullName}`, 20, logoY + Math.max(govHeight, tourismHeight) + 56);
  }
  doc.text(`Owner: ${summary.owner?.fullName ?? "—"}`, 20, logoY + Math.max(govHeight, tourismHeight) + 64);

  doc.setLineWidth(0.1);
  doc.line(20, pageHeight - 20, 190, pageHeight - 20);
  doc.setFontSize(8);
  doc.text("Auto-generated snapshot based on latest inspection data.", 105, pageHeight - 15, { align: "center" });
}

function drawBody(doc: JsPDFInstance, summary: InspectionReportSummary) {
  let cursorY = 90;
  doc.setFont("times", "bold");
  doc.setFontSize(11);
  doc.text("Compliance Overview", 20, cursorY);
  doc.setFont("times", "normal");
  cursorY += 6;

  const mandatoryChecklist = summary.report.mandatoryChecklist as Record<string, boolean> | null;
  const desirableChecklist = summary.report.desirableChecklist as Record<string, boolean> | null;
  const mandatoryChecked = mandatoryChecklist ? Object.values(mandatoryChecklist).filter(Boolean).length : 0;
  const desirableChecked = desirableChecklist ? Object.values(desirableChecklist).filter(Boolean).length : 0;

  doc.text(`Mandatory: ${mandatoryChecked}/${MANDATORY_TOTAL} checkpoints`, 20, cursorY);
  cursorY += 5;
  doc.text(`Desirable: ${desirableChecked}/${DESIRABLE_TOTAL} checkpoints`, 20, cursorY);
  cursorY += 8;

  doc.setFont("times", "bold");
  doc.text("Summary of Findings", 20, cursorY);
  cursorY += 6;
  doc.setFont("times", "normal");
  const findings = summary.report.detailedFindings?.trim() || "No remarks recorded.";
  cursorY = addWrappedText(doc, findings, 20, cursorY, 170, 5);
  cursorY += 6;

  if (summary.application.siteInspectionNotes) {
    doc.setFont("times", "bold");
    doc.text("DTDO Notes", 20, cursorY);
    cursorY += 6;
    doc.setFont("times", "normal");
    cursorY = addWrappedText(doc, summary.application.siteInspectionNotes, 20, cursorY, 170, 5);
    cursorY += 6;
  }

}

function addWrappedText(
  doc: JsPDFInstance,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const lines = doc.splitTextToSize(text, maxWidth);
  lines.forEach((line: string) => {
    doc.text(line, x, y);
    y += lineHeight;
  });
  return y;
}
