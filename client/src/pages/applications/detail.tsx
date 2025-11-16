import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CheckCircle2, XCircle, Building2, User, MapPin, Phone, Mail, Bed, IndianRupee, FileText, ArrowLeftCircle, ClipboardCheck, CalendarClock, FileImage, Download, Images, Award, CreditCard, QrCode, Printer } from "lucide-react";
import himachalTourismLogo from "@assets/WhatsApp Image 2025-10-25 at 07.59.16_5c0e8739_1761362811579.jpg";
import hpGovtLogo from "@assets/WhatsApp Image 2025-10-25 at 08.03.16_1cdc4198_1761362811579.jpg";
import type { HomestayApplication, User as UserType, Document } from "@shared/schema";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { ImageGallery } from "@/components/ImageGallery";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { generateCertificatePDF, type CertificateFormat } from "@/lib/certificateGenerator";
import { fetchInspectionReportSummary } from "@/lib/inspection-report";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { buildObjectViewUrl } from "@/lib/utils";
import { ApplicationTimelineCard } from "@/components/application/application-timeline-card";
import { InspectionReportCard } from "@/components/application/inspection-report-card";
import { isCorrectionRequiredStatus } from "@/constants/workflow";
import { formatDistanceToNow } from "date-fns";

type DocumentStatusMeta = {
  label: string;
  badgeClass: string;
  noteBgClass: string;
  noteTextClass: string;
};

const DOCUMENT_STATUS_META: Record<string, DocumentStatusMeta> = {
  pending: {
    label: "Pending review",
    badgeClass: "bg-slate-100 text-slate-700",
    noteBgClass: "bg-slate-50 border-slate-200",
    noteTextClass: "text-slate-700",
  },
  verified: {
    label: "Verified",
    badgeClass: "bg-emerald-50 text-emerald-700",
    noteBgClass: "bg-emerald-50 border-emerald-200",
    noteTextClass: "text-emerald-800",
  },
  needs_correction: {
    label: "Needs correction",
    badgeClass: "bg-amber-50 text-amber-800",
    noteBgClass: "bg-amber-50 border-amber-200",
    noteTextClass: "text-amber-900",
  },
  rejected: {
    label: "Rejected",
    badgeClass: "bg-rose-50 text-rose-700",
    noteBgClass: "bg-rose-50 border-rose-200",
    noteTextClass: "text-rose-800",
  },
};

const getDocumentStatusMeta = (status?: string | null): DocumentStatusMeta | null => {
  if (!status) return null;
  const normalized = status.toLowerCase();
  if (DOCUMENT_STATUS_META[normalized]) {
    return DOCUMENT_STATUS_META[normalized];
  }
  const fallbackLabel = status.replace(/_/g, " ");
  return {
    label: fallbackLabel,
    badgeClass: "bg-muted text-muted-foreground",
    noteBgClass: "bg-muted/40 border-border",
    noteTextClass: "text-muted-foreground",
  };
};

export default function ApplicationDetail() {
  const [, params] = useRoute("/applications/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [officerComments, setOfficerComments] = useState("");
  
  // New officer action states
  const [sendBackFeedback, setSendBackFeedback] = useState("");
  const [sendBackIssues, setSendBackIssues] = useState("");
  const [inspectionDate, setInspectionDate] = useState("");
  const [inspectionNotes, setInspectionNotes] = useState("");
  
  // Inspection completion states
  const [inspectionOutcome, setInspectionOutcome] = useState<'approved' | 'corrections_needed' | 'rejected'>('approved');
  const [roomCountVerified, setRoomCountVerified] = useState(false);
  const [roomCountActual, setRoomCountActual] = useState("");
  const [amenitiesVerified, setAmenitiesVerified] = useState(false);
  const [amenitiesIssues, setAmenitiesIssues] = useState("");
  const [fireSafetyVerified, setFireSafetyVerified] = useState(false);
  const [fireSafetyIssues, setFireSafetyIssues] = useState("");
  const [categoryRecommendation, setCategoryRecommendation] = useState("");
  const [issuesFound, setIssuesFound] = useState("");
  const [inspectionCompletionNotes, setInspectionCompletionNotes] = useState("");
  const certificateFormatOptions: { value: CertificateFormat; label: string; description: string }[] = [
    { value: "policy_heritage", label: "Official RC Format", description: "Golden bordered Form-A certificate approved for issuance" },
  ];
  const [certificateFormat, setCertificateFormat] =
    useState<CertificateFormat>("policy_heritage");
  const [isGeneratingCertificate, setIsGeneratingCertificate] = useState(false);
  const activeCertificateFormat =
    certificateFormatOptions.find((option) => option.value === certificateFormat) ??
    certificateFormatOptions[0];
  
  // Image gallery state
  const [isGalleryOpen, setIsGalleryOpen] = useState(false);
  const [galleryInitialIndex, setGalleryInitialIndex] = useState(0);

  // Determine whether owner can edit/resubmit

  const applicationId = params?.id;

  const { data: userData } = useQuery<{ user: UserType }>({
    queryKey: ["/api/auth/me"],
  });

  const { data: applicationData, isLoading } = useQuery<{ application: HomestayApplication }>({
    queryKey: ["/api/applications", applicationId],
    enabled: !!applicationId,
  });

  const { data: documentsData, isLoading: isLoadingDocuments } = useQuery<{ documents: Document[] }>({
    queryKey: ['/api/applications', applicationId, 'documents'],
    enabled: !!applicationId,
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ action, comments }: { action: "approve" | "reject"; comments: string }) => {
      const response = await apiRequest("POST", `/api/applications/${applicationId}/review`, {
        action,
        comments,
      });
      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/applications", applicationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      toast({
        title: variables.action === "approve" ? "Application Approved" : "Application Rejected",
        description: `The application has been ${variables.action}d successfully.`,
      });
      setOfficerComments("");
    },
    onError: () => {
      toast({
        title: "Review failed",
        description: "Failed to process review. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Send Back Mutation
  const sendBackMutation = useMutation({
    mutationFn: async ({ feedback, issuesFound }: { feedback: string; issuesFound: string }) => {
      const response = await apiRequest("POST", `/api/applications/${applicationId}/send-back`, {
        feedback,
        issuesFound,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/applications", applicationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      toast({
        title: "Application Sent Back",
        description: "The application has been sent back to the applicant for corrections.",
      });
      setSendBackFeedback("");
      setSendBackIssues("");
    },
    onError: () => {
      toast({
        title: "Action failed",
        description: "Failed to send back application. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Move to Inspection Mutation
  const moveToInspectionMutation = useMutation({
    mutationFn: async ({ scheduledDate, notes }: { scheduledDate: string; notes: string }) => {
      const response = await apiRequest("POST", `/api/applications/${applicationId}/move-to-inspection`, {
        scheduledDate,
        notes,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/applications", applicationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      toast({
        title: "Inspection Scheduled",
        description: "The site inspection has been scheduled successfully.",
      });
      setInspectionDate("");
      setInspectionNotes("");
    },
    onError: () => {
      toast({
        title: "Action failed",
        description: "Failed to schedule inspection. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Complete Inspection Mutation
  const completeInspectionMutation = useMutation({
    mutationFn: async () => {
      const findings = {
        roomCountVerified,
        roomCountActual: roomCountActual ? parseInt(roomCountActual) : undefined,
        amenitiesVerified,
        amenitiesIssues,
        fireSafetyVerified,
        fireSafetyIssues,
        categoryRecommendation,
        overallSatisfactory: inspectionOutcome === 'approved',
        issuesFound,
      };
      
      const response = await apiRequest("POST", `/api/applications/${applicationId}/complete-inspection`, {
        outcome: inspectionOutcome,
        findings,
        notes: inspectionCompletionNotes,
      });
      return response.json();
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/applications", applicationId] });
      queryClient.invalidateQueries({ queryKey: ["/api/applications"] });
      
      const outcomeMessages = {
        approved: "Application approved and moved to payment pending",
        corrections_needed: "Application sent back for corrections",
        rejected: "Application rejected"
      };
      
      toast({
        title: "Inspection Completed",
        description: outcomeMessages[inspectionOutcome],
      });
      
      // Reset form
      setInspectionOutcome('approved');
      setRoomCountVerified(false);
      setRoomCountActual("");
      setAmenitiesVerified(false);
      setAmenitiesIssues("");
      setFireSafetyVerified(false);
      setFireSafetyIssues("");
      setCategoryRecommendation("");
      setIssuesFound("");
      setInspectionCompletionNotes("");
    },
    onError: () => {
      toast({
        title: "Action failed",
        description: "Failed to complete inspection. Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading application...</p>
        </div>
      </div>
    );
  }

  if (!applicationData?.application) {
    return (
      <div className="bg-background flex items-center justify-center">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Application Not Found</CardTitle>
            <CardDescription>The application you're looking for doesn't exist.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setLocation("/dashboard")} data-testid="button-back-dashboard">
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const app = applicationData.application;

  const handleGenerateCertificate = async () => {
    if (!app) {
      return;
    }
    setIsGeneratingCertificate(true);
    try {
      let inspectionSummary = null;
      if (applicationId) {
        try {
          inspectionSummary = await fetchInspectionReportSummary(applicationId);
        } catch (error) {
          console.warn("[certificate] Failed to fetch inspection reference", error);
        }
      }

      generateCertificatePDF(app, certificateFormat, {
        inspectionReport: inspectionSummary ?? undefined,
      });
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Unable to prepare certificate right now.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingCertificate(false);
    }
  };
  const user = userData?.user;
  const isDistrictOfficer = user?.role === "district_officer";
  const isStateOfficer = user?.role === "state_officer";
  const isPropertyOwner = user?.role === "property_owner";
  const currentStatus = app.status ?? "draft";
  const totalFeeValue = Number(app.totalFee ?? 0);
  const ownerEditableStatuses = [
    'draft',
    'sent_back_for_corrections',
    'reverted_to_applicant',
    'reverted_by_dtdo',
    'objection_raised',
  ];
  const needsCorrectionsAlert =
    isPropertyOwner && isCorrectionRequiredStatus(currentStatus);
  const correctionMessage =
    app.clarificationRequested || (app as any).dtdoRemarks || (app as any).daRemarks || null;
  const correctionRelative =
    needsCorrectionsAlert && app.updatedAt
      ? formatDistanceToNow(new Date(app.updatedAt), { addSuffix: true })
      : null;
  const canEdit = isPropertyOwner && ownerEditableStatuses.includes(currentStatus);
  
  // District officers can review pending applications
  // State officers can review applications in state_review status
  const canReview = (isDistrictOfficer && currentStatus === "pending") || 
                    (isStateOfficer && currentStatus === "state_review");

  const startCase = (input: string) =>
    input
      .replace(/[_-]/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(" ")
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");

  const getStatusBadge = (status: string) => {
    const config = {
      draft: { label: "Draft", variant: "outline" as const },
      pending: { label: "District Review", variant: "secondary" as const },
      state_review: { label: "State Review", variant: "secondary" as const },
      objection_raised: { label: "DTDO Objection", variant: "warning" as const },
      approved: { label: "Approved", variant: "default" as const },
      rejected: { label: "Rejected", variant: "destructive" as const },
    };
    return config[status as keyof typeof config] || config.draft;
  };

  const getCategoryBadge = (category: string) => {
    const config = {
      diamond: { label: "Diamond", variant: "default" as const },
      gold: { label: "Gold", variant: "secondary" as const },
      silver: { label: "Silver", variant: "outline" as const },
    };
    return config[category as keyof typeof config];
  };

  const displayValue = (value: unknown, fallback = "—"): string => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : fallback;
    }
    if (value === null || value === undefined) {
      return fallback;
    }
    return String(value);
  };

  const locationTypeLabels: Record<string, string> = {
    mc: "Municipal Corporation / Municipal Council",
    tcp: "Town & Country Planning / SADA / NP Area",
    gp: "Gram Panchayat",
  };

  const handlePrint = () => {
    window.print();
  };

  const asNumber = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  const formatCurrency = (value: unknown) => {
    const num = asNumber(value);
    if (num === null) return "—";
    return `₹${num.toLocaleString("en-IN")}`;
  };

  const formatDistance = (value: unknown) => {
    const num = asNumber(value);
    if (num === null || num <= 0) return "Enter distance in KM";
    return `${num} km`;
  };

  const formatArea = (value: unknown) => {
    const num = asNumber(value);
    if (num === null || num === 0) return "—";
    return `${num} sq ft`;
  };

  const formatDocumentType = (value?: string | null) => {
    if (!value) return "Supporting Document";
    return startCase(value);
  };

  const statusLabel = getStatusBadge(currentStatus).label;
  const categoryLabel = app.category ? startCase(app.category) : "—";
  const projectTypeLabel =
    app.projectType === "new_project"
      ? "New Project"
      : app.projectType === "new_rooms"
        ? "Existing + New Rooms"
        : displayValue(app.projectType);
  const ownershipLabel = app.propertyOwnership ? startCase(app.propertyOwnership) : "—";
  const locationTypeLabel = locationTypeLabels[app.locationType ?? ""] ?? "—";

  const submissionDate = app.submittedAt ? new Date(app.submittedAt) : null;
  const lastUpdatedAt = app.updatedAt ? new Date(app.updatedAt) : null;

  const amenityLabels: Record<string, string> = {
    ac: "Air Conditioning",
    wifi: "WiFi",
    parking: "Parking",
    restaurant: "Restaurant",
    hotWater: "Hot Water",
    tv: "Television",
    laundry: "Laundry Service",
    roomService: "Room Service",
    garden: "Garden",
    mountainView: "Mountain View",
    petFriendly: "Pet Friendly",
  };

  const selectedAmenityLabels = Object.entries((app.amenities ?? {}) as Record<string, any>)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => amenityLabels[key] ?? startCase(key));

  const allDocumentsRaw = (documentsData?.documents ??
    (Array.isArray(app.documents) ? app.documents : [])) as Array<any>;

  const propertyPhotoDocs = allDocumentsRaw.filter(
    (doc) => (doc?.documentType || doc?.type) === "property_photo",
  );

  const supportingDocs = allDocumentsRaw.filter(
    (doc) => (doc?.documentType || doc?.type) !== "property_photo",
  );

  const normalizedSupportingDocs = supportingDocs.map((doc, index) => ({
    type: formatDocumentType(doc?.documentType || doc?.type),
    name: displayValue(doc?.fileName || doc?.name || `Document ${index + 1}`),
  }));

  const printGeneratedAt = new Date();

  return (
    <>
      <div className="print-only application-print-sheet text-black text-sm leading-relaxed">
        <div className="flex items-center justify-between border-b border-gray-300 pb-4 mb-6">
          <img src={himachalTourismLogo} alt="Himachal Tourism" className="h-16 w-auto" />
          <div className="text-center">
            <p className="uppercase tracking-[0.35em] text-xs text-gray-600">
              Government of Himachal Pradesh
            </p>
            <h1 className="text-2xl font-semibold mt-1">HP Tourism eServices</h1>
            <p className="text-sm mt-1">Homestay Registration Application</p>
          </div>
          <img src={hpGovtLogo} alt="Government of Himachal Pradesh" className="h-16 w-auto" />
        </div>

        <div className="grid grid-cols-2 gap-6 border border-gray-300 rounded-lg p-4 mb-8 break-inside-avoid">
          <div className="space-y-1">
            <p className="text-xs uppercase text-gray-600">Application Number</p>
            <p className="font-semibold">{displayValue(app.applicationNumber)}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-gray-600">Current Status</p>
            <p className="font-semibold">{statusLabel}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-gray-600">Submitted On</p>
            <p>{submissionDate ? submissionDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—"}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-gray-600">Last Updated</p>
            <p>{lastUpdatedAt ? lastUpdatedAt.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—"}</p>
          </div>
        </div>

        <section className="mb-6 break-inside-avoid print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">1. Property Details</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 mt-4">
            <div>
              <p className="text-xs uppercase text-gray-600">Property Name</p>
              <p>{displayValue(app.propertyName)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Category</p>
              <p>{categoryLabel}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Address</p>
              <p>{displayValue(app.address)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Location Type</p>
              <p>{locationTypeLabel}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">District</p>
              <p>{displayValue(app.district)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Tehsil</p>
              <p>{displayValue(app.tehsil)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Village / Locality</p>
              <p>{displayValue(app.gramPanchayat)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Urban Local Body</p>
              <p>{displayValue(app.urbanBody)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">PIN Code</p>
              <p>{displayValue(app.pincode)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Total Rooms</p>
              <p>{displayValue(app.totalRooms)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Ownership Type</p>
              <p>{ownershipLabel}</p>
            </div>
          </div>
        </section>

        <section className="mb-6 break-inside-avoid print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">2. Owner Information</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 mt-4">
            <div>
              <p className="text-xs uppercase text-gray-600">Full Name</p>
              <p>{displayValue(app.ownerName)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Gender</p>
              <p>{app.ownerGender ? startCase(app.ownerGender) : "—"}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Mobile Number</p>
              <p>{displayValue(app.ownerMobile)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Email Address</p>
              <p>{displayValue(app.ownerEmail)}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs uppercase text-gray-600">Aadhaar Number</p>
              <p>{displayValue(app.ownerAadhaar)}</p>
            </div>
          </div>
        </section>

        <section className="mb-6 break-inside-avoid print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">3. Accommodation Details</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 mt-4">
            <div>
              <p className="text-xs uppercase text-gray-600">Project Type</p>
              <p>{projectTypeLabel}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Property Area</p>
              <p>{formatArea(app.propertyArea)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Single Bed Rooms</p>
              <p>{displayValue(app.singleBedRooms)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Double Bed Rooms</p>
              <p>{displayValue(app.doubleBedRooms)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Family Suites</p>
              <p>{displayValue(app.familySuites)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Attached Washrooms</p>
              <p>{displayValue(app.attachedWashrooms)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Proposed Tariff</p>
              <p>{formatCurrency(app.proposedRoomRate)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Single Bed Room Rate</p>
              <p>{formatCurrency(app.singleBedRoomRate)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Double Bed Room Rate</p>
              <p>{formatCurrency(app.doubleBedRoomRate)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Family Suite Rate</p>
              <p>{formatCurrency(app.familySuiteRate)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">GSTIN</p>
              <p>{displayValue(app.gstin)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Certificate Validity (Years)</p>
              <p>{displayValue(app.certificateValidityYears)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Pangi Sub Division</p>
              <p>{app.isPangiSubDivision ? "Yes" : "No"}</p>
            </div>
          </div>
        </section>

        <section className="mb-6 break-inside-avoid print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">4. Distances & Public Areas</h2>
          <div className="grid grid-cols-3 gap-x-6 gap-y-4 mt-4">
            <div>
              <p className="text-xs uppercase text-gray-600">Airport</p>
              <p>{formatDistance(app.distanceAirport)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Railway Station</p>
              <p>{formatDistance(app.distanceRailway)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">City Center</p>
              <p>{formatDistance(app.distanceCityCenter)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Shopping Area</p>
              <p>{formatDistance(app.distanceShopping)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Bus Stand</p>
              <p>{formatDistance(app.distanceBusStand)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Lobby Area</p>
              <p>{formatArea(app.lobbyArea)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Dining Area</p>
              <p>{formatArea(app.diningArea)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Parking</p>
              <p>{displayValue(app.parkingArea)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Nearest Hospital</p>
              <p>{displayValue(app.nearestHospital)}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-6 mt-4">
            <div>
              <p className="text-xs uppercase text-gray-600">Eco-Friendly Facilities</p>
              <p>{displayValue(app.ecoFriendlyFacilities)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Facilities for Differently Abled</p>
              <p>{displayValue(app.differentlyAbledFacilities)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Fire Safety Equipment</p>
              <p>{displayValue(app.fireEquipmentDetails)}</p>
            </div>
          </div>
        </section>

        <section className="mb-6 break-inside-avoid print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">5. Amenities</h2>
          <div className="mt-4">
            {selectedAmenityLabels.length > 0 ? (
              <ul className="grid grid-cols-2 gap-2 text-sm list-disc list-inside">
                {selectedAmenityLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm">No amenities selected.</p>
            )}
          </div>
        </section>

        <section className="mb-6 break-inside-avoid print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">6. Supporting Documents</h2>
          <div className="mt-4">
            {normalizedSupportingDocs.length > 0 ? (
              <table className="w-full border border-gray-300 text-sm">
                <thead className="bg-gray-100">
                  <tr className="text-left">
                    <th className="border border-gray-300 px-3 py-2 w-1/3">Document Type</th>
                    <th className="border border-gray-300 px-3 py-2">File Name</th>
                  </tr>
                </thead>
                <tbody>
                  {normalizedSupportingDocs.map((doc, index) => (
                    <tr key={`${doc.name}-${index}`} className="break-inside-avoid">
                      <td className="border border-gray-300 px-3 py-2">{doc.type}</td>
                      <td className="border border-gray-300 px-3 py-2">{doc.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm">No supporting documents uploaded.</p>
            )}
            <p className="text-sm mt-3">
              Property Photos Submitted: {propertyPhotoDocs.length > 0 ? `${propertyPhotoDocs.length} file(s)` : "None"}
            </p>
          </div>
        </section>

        <section className="mb-6 print-section">
          <h2 className="text-base font-semibold border-b border-gray-300 pb-2">7. Fee Summary</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 mt-4">
            <div>
              <p className="text-xs uppercase text-gray-600">Base Fee</p>
              <p>{formatCurrency(app.baseFee)}</p>
            </div>
            <div>
              <p className="text-xs uppercase text-gray-600">Total Discounts</p>
              <p>{formatCurrency(app.totalDiscount)}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs uppercase text-gray-600">Total Payable Fee</p>
              <p className="font-semibold">{formatCurrency(app.totalFee)}</p>
            </div>
          </div>
        </section>

        <section className="text-xs text-gray-600 border-t border-gray-200 pt-4 print-section">
          <p>
            Generated on {printGeneratedAt.toLocaleString("en-IN", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
        </section>
      </div>

      <div className="print:hidden container mx-auto px-4 py-8 space-y-4">
        {needsCorrectionsAlert && (
          <Alert className="border-amber-300 bg-amber-50 md:sticky md:top-4 z-10">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <div>
              <AlertTitle>Corrections required</AlertTitle>
              <AlertDescription className="space-y-2">
                <p className="text-sm">
                  Your application requires updates before we can continue processing.{" "}
                  {correctionRelative ? `Last updated ${correctionRelative}.` : null}
                </p>
                {correctionMessage ? (
                  <p className="text-sm text-amber-700 whitespace-pre-line">{correctionMessage}</p>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLocation(`/applications/new?application=${app.id}`)}
                  data-testid="button-banner-continue-corrections"
                >
                  Continue Corrections
                </Button>
              </AlertDescription>
            </div>
          </Alert>
        )}
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Badge {...getStatusBadge(currentStatus)} data-testid="badge-status">
              {getStatusBadge(currentStatus).label}
            </Badge>
            <Badge {...getCategoryBadge(app.category || 'silver')} data-testid="badge-category">
              {getCategoryBadge(app.category || 'silver').label}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePrint} data-testid="button-print-application">
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
          </div>
        </div>

        {canEdit && (
          <div className="mb-6 border border-amber-200 bg-amber-50/60 rounded-lg p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-semibold text-amber-800">Action required: update and resubmit</p>
              <p className="text-sm text-amber-700">We restored your previous answers so you can fix remarks quickly. Review each step and submit once corrections are complete.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setLocation(`/applications/new?application=${app.id}`)}
                data-testid="button-open-corrections"
              >
                <ClipboardCheck className="w-4 h-4 mr-2" />
                Open Guided Editor
              </Button>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-6">
            {/* Property Information */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-primary" />
                  <CardTitle>Property Information</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-muted-foreground">Property Name</Label>
                  <p className="text-lg font-medium" data-testid="text-property-name">{app.propertyName}</p>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Address</Label>
                    <p data-testid="text-address">{displayValue(app.address)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">District</Label>
                    <p className="flex items-center gap-2" data-testid="text-district">
                      <MapPin className="w-4 h-4 text-muted-foreground" />
                      {displayValue(app.district)}
                    </p>
                  </div>
                </div>
                <div>
                  <Label className="text-muted-foreground">Tehsil</Label>
                  <p data-testid="text-tehsil">{displayValue(app.tehsil)}</p>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Village / Locality</Label>
                    <p data-testid="text-gram-panchayat">{displayValue(app.gramPanchayat)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Urban Local Body</Label>
                    <p data-testid="text-urban-body">{displayValue(app.urbanBody)}</p>
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">PIN Code</Label>
                    <p data-testid="text-pincode">{displayValue(app.pincode)}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Total Rooms</Label>
                    <p className="flex items-center gap-2" data-testid="text-rooms">
                      <Bed className="w-4 h-4 text-muted-foreground" />
                      {app.totalRooms} rooms
                    </p>
                  </div>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Location Type</Label>
                    <p data-testid="text-location-type">
                      {locationTypeLabels[app.locationType ?? ""] ?? "—"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Project Type</Label>
                    <p data-testid="text-project-type">
                      {app.projectType === "new_project"
                        ? "New Project"
                        : app.projectType === "new_rooms"
                          ? "Existing + New Rooms"
                          : displayValue(app.projectType)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Registration Certificate - Show when approved */}
            {currentStatus === 'approved' && app.certificateNumber && (
              <Card className="border-green-200 bg-green-50/50">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Award className="w-5 h-5 text-green-600" />
                    <CardTitle className="text-green-800">Registration Certificate Issued</CardTitle>
                  </div>
                  <CardDescription>
                    Your homestay is officially registered with HP Tourism
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded-lg border border-green-200">
                      <Label className="text-muted-foreground text-xs">Certificate Number</Label>
                      <p className="text-lg font-bold text-green-700" data-testid="text-certificate-number">
                        {app.certificateNumber}
                      </p>
                    </div>
                    {app.certificateIssuedDate && (
                      <div className="bg-white p-4 rounded-lg border border-green-200">
                        <Label className="text-muted-foreground text-xs">Issue Date</Label>
                        <p className="text-lg font-semibold text-green-700" data-testid="text-certificate-date">
                          {new Date(app.certificateIssuedDate).toLocaleDateString('en-IN', { 
                            day: 'numeric', 
                            month: 'short', 
                            year: 'numeric' 
                          })}
                        </p>
                      </div>
                    )}
                  </div>
                  {app.certificateExpiryDate && (
                    <div className="bg-white p-3 rounded-lg border border-green-200">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-muted-foreground text-xs">Valid Until</Label>
                          <p className="font-medium text-green-700">
                            {new Date(app.certificateExpiryDate).toLocaleDateString('en-IN', { 
                              day: 'numeric', 
                              month: 'long', 
                              year: 'numeric' 
                            })}
                          </p>
                        </div>
                        <Badge variant="default" className="bg-green-600">
                          Active
                        </Badge>
                      </div>
                    </div>
                  )}
                  <div className="bg-white p-3 rounded-lg border border-green-200 space-y-2">
                    <Label className="text-muted-foreground text-xs">Certificate Format</Label>
                    <div className="flex flex-wrap gap-2">
                      {certificateFormatOptions.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          size="sm"
                          variant={certificateFormat === option.value ? "default" : "outline"}
                          className={
                            certificateFormat === option.value
                              ? "bg-green-600 hover:bg-green-700 text-white"
                              : "text-green-700 border-green-200"
                          }
                          onClick={() => setCertificateFormat(option.value)}
                        >
                          {option.label}
                        </Button>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {activeCertificateFormat.description}
                    </p>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button 
                      className="flex-1 bg-green-600 hover:bg-green-700" 
                      onClick={handleGenerateCertificate}
                      data-testid="button-download-certificate"
                      disabled={isGeneratingCertificate}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {isGeneratingCertificate ? "Preparing certificate..." : `Download ${activeCertificateFormat.label}`}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Payment Pending - Show when payment is pending (property owners only) */}
            {currentStatus === 'payment_pending' && userData?.user?.role === 'property_owner' && (
              <Card className="border-primary">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-5 h-5 text-primary" />
                    <CardTitle className="text-primary">Payment Required</CardTitle>
                  </div>
                  <CardDescription>
                    Complete payment to receive your registration certificate
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="p-3 bg-primary/5 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-muted-foreground">Total Registration Fee</span>
                        <span className="text-2xl font-bold text-primary">₹{totalFeeValue.toLocaleString('en-IN')}</span>
                      </div>
                    </div>
                    <Button 
                      className="w-full" 
                      onClick={() => setLocation(`/applications/${app.id}/payment-himkosh`)}
                      data-testid="button-proceed-payment"
                    >
                      <CreditCard className="w-4 h-4 mr-2" />
                      Proceed to HimKosh
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Payment Status - Show for officers when payment is pending */}
            {currentStatus === 'payment_pending' && userData?.user?.role !== 'property_owner' && (
              <Card className="border-primary/50">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-5 h-5 text-primary" />
                    <CardTitle className="text-primary">Payment Pending</CardTitle>
                  </div>
                  <CardDescription>
                    Awaiting payment from property owner
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="p-3 bg-primary/5 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm text-muted-foreground">Total Registration Fee</span>
                      <span className="text-2xl font-bold text-primary">₹{totalFeeValue.toLocaleString('en-IN')}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">
                      The property owner needs to complete payment before certificate can be issued.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Owner Information */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <User className="w-5 h-5 text-primary" />
                  <CardTitle>Owner Information</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label className="text-muted-foreground">Full Name</Label>
                    <p data-testid="text-owner-name">{app.ownerName}</p>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Mobile Number</Label>
                    <p className="flex items-center gap-2" data-testid="text-owner-mobile">
                      <Phone className="w-4 h-4 text-muted-foreground" />
                      {app.ownerMobile}
                    </p>
                  </div>
                </div>
                {app.ownerEmail && (
                  <div>
                    <Label className="text-muted-foreground">Email Address</Label>
                    <p className="flex items-center gap-2" data-testid="text-owner-email">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      {app.ownerEmail}
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-muted-foreground">Aadhaar Number</Label>
                  <p data-testid="text-owner-aadhaar">{app.ownerAadhaar.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")}</p>
                </div>
              </CardContent>
            </Card>

            {/* Amenities */}
            {app.amenities && typeof app.amenities === 'object' && Object.keys(app.amenities).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Amenities & Facilities</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {Object.entries(app.amenities)
                      .filter(([_, value]) => value)
                      .map(([key]) => (
                        <div key={key} className="flex items-center gap-2 p-2 bg-muted rounded-md">
                          <div className="w-2 h-2 rounded-full bg-primary"></div>
                          <span className="text-sm capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Feedback Alerts for sent back applications */}
            {canEdit && (app.clarificationRequested || app.dtdoRemarks) && (
              <>
                {app.clarificationRequested && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Feedback from Dealing Assistant</AlertTitle>
                    <AlertDescription>{app.clarificationRequested}</AlertDescription>
                  </Alert>
                )}
                {app.dtdoRemarks && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Feedback from DTDO</AlertTitle>
                    <AlertDescription>{app.dtdoRemarks}</AlertDescription>
                  </Alert>
                )}
              </>
            )}

            {/* Uploaded Documents */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <FileImage className="w-5 h-5 text-primary" />
                    <CardTitle>Uploaded Documents</CardTitle>
                  </div>
                  <CardDescription className="mt-2">
                    {isLoadingDocuments 
                      ? "Loading documents..."
                      : documentsData?.documents && documentsData.documents.length > 0 
                      ? `${documentsData.documents.length} document(s) uploaded`
                      : "No documents uploaded yet"}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {canEdit && (
                  <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                    Use the guided editor to replace or add documents before you resubmit. The list below shows the files currently attached to your application.
                  </div>
                )}
                {isLoadingDocuments ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
                    <p className="text-sm">Loading documents...</p>
                  </div>
                ) : !app.ownershipProofUrl && !app.aadhaarCardUrl && !app.propertyPhotosUrls?.length && (!documentsData?.documents || documentsData.documents.length === 0) ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileImage className="w-12 h-12 mx-auto mb-3 opacity-50" />
                    <p className="text-sm">No documents uploaded yet</p>
                    <p className="text-xs mt-1">Documents will appear here once the applicant uploads them</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Property Photos Gallery */}
                    {(() => {
                      const propertyPhotos = documentsData?.documents?.filter(
                        doc => doc.documentType === 'property_photo' && doc.mimeType.startsWith('image/')
                      ) || [];
                      
                      if (propertyPhotos.length > 0) {
                        return (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Images className="w-5 h-5 text-primary" />
                                <p className="text-sm font-medium">Property Photos ({propertyPhotos.length})</p>
                              </div>
                              <Button
                                data-testid="button-view-gallery"
                                variant="default"
                                size="sm"
                                onClick={() => {
                                  setGalleryInitialIndex(0);
                                  setIsGalleryOpen(true);
                                }}
                              >
                                <Images className="w-4 h-4 mr-2" />
                                View Gallery
                              </Button>
                            </div>
                            <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                              {propertyPhotos.map((photo, index) => {
                                const photoAny = photo as Record<string, unknown>;
                                const candidateUrl =
                                  typeof photoAny.fileUrl === "string" && photoAny.fileUrl.length > 0
                                    ? (photoAny.fileUrl as string)
                                    : typeof photoAny.url === "string" && (photoAny.url as string).length > 0
                                      ? (photoAny.url as string)
                                      : undefined;
                                const resolvedSrc =
                                  candidateUrl ||
                                  (photo.filePath
                                    ? buildObjectViewUrl(photo.filePath, {
                                        mimeType:
                                          typeof photo.mimeType === "string"
                                            ? photo.mimeType
                                            : undefined,
                                        fileName:
                                          typeof photo.fileName === "string"
                                            ? photo.fileName
                                            : undefined,
                                      })
                                    : undefined);

                                const statusMeta = getDocumentStatusMeta(photo.verificationStatus);
                                const normalizedNotes =
                                  typeof photo.verificationNotes === "string" && photo.verificationNotes.trim().length > 0
                                    ? photo.verificationNotes.trim()
                                    : "";
                                return (
                                <div
                                  key={photo.id}
                                  className="space-y-2"
                                >
                                  <div
                                    className="aspect-square border rounded-md overflow-hidden cursor-pointer hover-elevate active-elevate-2"
                                    onClick={() => {
                                      setGalleryInitialIndex(index);
                                      setIsGalleryOpen(true);
                                    }}
                                    data-testid={`thumbnail-property-${index}`}
                                  >
                                    {resolvedSrc ? (
                                      <img
                                        src={resolvedSrc}
                                        alt={photo.fileName || `Property photo ${index + 1}`}
                                        className="w-full h-full object-cover"
                                      />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground bg-muted">
                                        Missing Image
                                      </div>
                                    )}
                                  </div>
                                  {(statusMeta || normalizedNotes) && (
                                    <div
                                      className={`rounded-md border px-2 py-1.5 text-xs space-y-1 ${
                                        statusMeta?.noteBgClass ?? "bg-muted/40 border-border/40"
                                      }`}
                                    >
                                      {statusMeta && (
                                        <span
                                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusMeta.badgeClass}`}
                                        >
                                          {statusMeta.label}
                                        </span>
                                      )}
                                      {normalizedNotes && (
                                        <p className={`text-sm leading-relaxed ${statusMeta?.noteTextClass ?? "text-muted-foreground"}`}>
                                          {normalizedNotes}
                                        </p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                              })}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    
                    {/* Other Documents */}
                    {(() => {
                      const otherDocs = documentsData?.documents?.filter(
                        doc => doc.documentType !== 'property_photo'
                      ) || [];
                      
                      if (otherDocs.length > 0) {
                        return (
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-muted-foreground mb-2">Supporting Documents</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                              {otherDocs.map((doc) => {
                                const statusMeta = getDocumentStatusMeta(doc.verificationStatus);
                                const normalizedNotes =
                                  typeof doc.verificationNotes === "string" && doc.verificationNotes.trim().length > 0
                                    ? doc.verificationNotes.trim()
                                    : "";
                                return (
                                  <div key={doc.id} className="flex flex-col p-3 border rounded-md hover-elevate space-y-3">
                                    <div className="flex items-center gap-3">
                                      <div className="p-2 bg-primary/10 rounded flex-shrink-0">
                                        {doc.mimeType.startsWith('image/') ? (
                                          <FileImage className="w-5 h-5 text-primary" />
                                        ) : (
                                          <FileText className="w-5 h-5 text-primary" />
                                        )}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p className="font-medium text-sm truncate">{doc.fileName}</p>
                                        <p className="text-xs text-muted-foreground capitalize">{doc.documentType.replace(/_/g, ' ')}</p>
                                      </div>
                                    </div>
                                    {(statusMeta || normalizedNotes) && (
                                      <div
                                        className={`rounded-md border px-2 py-1.5 text-xs space-y-1 ${
                                          statusMeta?.noteBgClass ?? "bg-muted/40 border-border/40"
                                        }`}
                                      >
                                        {statusMeta && (
                                          <span
                                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusMeta.badgeClass}`}
                                          >
                                            {statusMeta.label}
                                          </span>
                                        )}
                                        {normalizedNotes && (
                                          <p className={`text-sm leading-relaxed ${statusMeta?.noteTextClass ?? "text-muted-foreground"}`}>
                                            {normalizedNotes}
                                          </p>
                                        )}
                                      </div>
                                    )}
                                    <div className="flex items-center justify-between pt-2 border-t">
                                      <span className="text-xs text-muted-foreground">
                                        {doc.fileSize ? (doc.fileSize / 1024).toFixed(1) : "0.0"} KB
                                      </span>
                                      <Button 
                                        size="sm" 
                                        variant="outline"
                                        onClick={() =>
                                          window.open(
                                            buildObjectViewUrl(doc.filePath, {
                                              mimeType: doc.mimeType,
                                              fileName: doc.fileName,
                                            }),
                                            '_blank'
                                          )
                                        }
                                        data-testid={`button-view-document-${doc.id}`}
                                      >
                                        <Download className="w-4 h-4 mr-1" />
                                        View
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {/* Ownership Proof */}
                    {app.ownershipProofUrl && (
                      <div className="flex items-center justify-between p-3 border rounded-md">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-primary/10 rounded">
                            <FileText className="w-5 h-5 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">Property Ownership Proof</p>
                            <p className="text-xs text-muted-foreground">Sale deed / Mutation certificate</p>
                          </div>
                        </div>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => window.open(app.ownershipProofUrl!, '_blank')}
                          data-testid="button-view-ownership"
                        >
                          <Download className="w-4 h-4 mr-1" />
                          View
                        </Button>
                      </div>
                    )}

                    {/* Aadhaar Card */}
                    {app.aadhaarCardUrl && (
                      <div className="flex items-center justify-between p-3 border rounded-md">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-primary/10 rounded">
                            <FileText className="w-5 h-5 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">Aadhaar Card</p>
                            <p className="text-xs text-muted-foreground">Owner identification</p>
                          </div>
                        </div>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => window.open(app.aadhaarCardUrl!, '_blank')}
                          data-testid="button-view-aadhaar"
                        >
                          <Download className="w-4 h-4 mr-1" />
                          View
                        </Button>
                      </div>
                    )}

                    {/* PAN Card */}
                    {app.panCardUrl && (
                      <div className="flex items-center justify-between p-3 border rounded-md">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-primary/10 rounded">
                            <FileText className="w-5 h-5 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">PAN Card</p>
                            <p className="text-xs text-muted-foreground">Tax identification</p>
                          </div>
                        </div>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => window.open(app.panCardUrl!, '_blank')}
                          data-testid="button-view-pan"
                        >
                          <Download className="w-4 h-4 mr-1" />
                          View
                        </Button>
                      </div>
                    )}

                    {/* GST Certificate */}
                    {app.gstCertificateUrl && (
                      <div className="flex items-center justify-between p-3 border rounded-md">
                        <div className="flex items-center gap-3">
                          <div className="p-2 bg-primary/10 rounded">
                            <FileText className="w-5 h-5 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">GST Certificate</p>
                            <p className="text-xs text-muted-foreground">Business registration</p>
                          </div>
                        </div>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => window.open(app.gstCertificateUrl!, '_blank')}
                          data-testid="button-view-gst"
                        >
                          <Download className="w-4 h-4 mr-1" />
                          View
                        </Button>
                      </div>
                    )}

                    {/* Property Photos */}
                    {app.propertyPhotosUrls && app.propertyPhotosUrls.length > 0 && (
                      <div className="border rounded-md p-3">
                        <div className="flex items-center gap-2 mb-3">
                          <FileImage className="w-5 h-5 text-primary" />
                          <p className="font-medium text-sm">Property Photos ({app.propertyPhotosUrls.length})</p>
                        </div>
                        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                          {app.propertyPhotosUrls.map((url, index) => (
                            <div 
                              key={index} 
                              className="aspect-square border rounded overflow-hidden cursor-pointer hover:opacity-75 transition-opacity"
                              onClick={() => window.open(url, '_blank')}
                              data-testid={`image-property-${index}`}
                            >
                              <img 
                                src={url} 
                                alt={`Property photo ${index + 1}`}
                                className="w-full h-full object-cover"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

              </CardContent>
            </Card>

            {/* Officer Review Section */}
            {canReview && (
              <Card>
                <CardHeader>
                  <CardTitle>Review Application</CardTitle>
                  <CardDescription>
                    {isDistrictOfficer 
                      ? "As a District Officer, you can approve (forwards to State review) or reject this application"
                      : "As a State Officer, you can grant final approval or reject this application"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label htmlFor="comments">Officer Comments</Label>
                    <Textarea
                      id="comments"
                      placeholder="Add your review comments here..."
                      value={officerComments}
                      onChange={(e) => setOfficerComments(e.target.value)}
                      className="mt-2"
                      rows={4}
                      data-testid="input-officer-comments"
                    />
                  </div>
                  <div className="flex gap-3">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="default"
                          className="flex-1"
                          disabled={reviewMutation.isPending}
                          data-testid="button-approve-trigger"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2" />
                          Approve Application
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Approve Application?</AlertDialogTitle>
                          <AlertDialogDescription>
                            {isDistrictOfficer ? (
                              <>This will approve the homestay application for <strong>{app.propertyName}</strong> and forward it to State Tourism for final review.</>
                            ) : (
                              <>This will grant final approval to <strong>{app.propertyName}</strong>. The property will be listed on the public portal.</>
                            )}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid="button-cancel-approve">Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => reviewMutation.mutate({ action: "approve", comments: officerComments })}
                            data-testid="button-confirm-approve"
                          >
                            Approve
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>

                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="destructive"
                          className="flex-1"
                          disabled={reviewMutation.isPending}
                          data-testid="button-reject-trigger"
                        >
                          <XCircle className="w-4 h-4 mr-2" />
                          Reject Application
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Reject Application?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will reject the homestay application for <strong>{app.propertyName}</strong>. 
                            Please ensure you've added comments explaining the rejection.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid="button-cancel-reject">Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => reviewMutation.mutate({ action: "reject", comments: officerComments })}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            data-testid="button-confirm-reject"
                          >
                            Reject
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* New Officer Workflow Actions */}
            {(isDistrictOfficer || isStateOfficer) && (
              <Card>
                <CardHeader>
                  <CardTitle>Officer Actions</CardTitle>
                  <CardDescription>
                    Available actions for this application (Status: {currentStatus.replace(/_/g, ' ')})
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Send Back for Corrections */}
                  {(currentStatus === 'submitted' || currentStatus === 'document_verification') && (
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline" className="w-full" data-testid="button-send-back">
                          <ArrowLeftCircle className="w-4 h-4 mr-2" />
                          Send Back for Corrections
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Send Application Back</DialogTitle>
                          <DialogDescription>
                            Return this application to the applicant for corrections or additional information.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor="feedback">Feedback to Applicant</Label>
                            <Textarea
                              id="feedback"
                              placeholder="Explain what needs to be corrected..."
                              value={sendBackFeedback}
                              onChange={(e) => setSendBackFeedback(e.target.value)}
                              rows={4}
                              data-testid="input-sendback-feedback"
                            />
                          </div>
                          <div>
                            <Label htmlFor="issues">Issues Found</Label>
                            <Textarea
                              id="issues"
                              placeholder="List specific issues that need to be addressed..."
                              value={sendBackIssues}
                              onChange={(e) => setSendBackIssues(e.target.value)}
                              rows={3}
                              data-testid="input-sendback-issues"
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            onClick={() => sendBackMutation.mutate({ feedback: sendBackFeedback, issuesFound: sendBackIssues })}
                            disabled={sendBackMutation.isPending || !sendBackFeedback || sendBackFeedback.length < 10}
                            data-testid="button-confirm-sendback"
                          >
                            Send Back
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}

                  {/* Schedule Site Inspection */}
                  {(currentStatus === 'document_verification' || currentStatus === 'submitted') && (
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline" className="w-full" data-testid="button-schedule-inspection">
                          <CalendarClock className="w-4 h-4 mr-2" />
                          Schedule Site Inspection
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Schedule Site Inspection</DialogTitle>
                          <DialogDescription>
                            Set a date for the on-site inspection of this property.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4">
                          <div>
                            <Label htmlFor="inspectionDate">Inspection Date</Label>
                            <Input
                              id="inspectionDate"
                              type="date"
                              value={inspectionDate}
                              onChange={(e) => setInspectionDate(e.target.value)}
                              data-testid="input-inspection-date"
                            />
                          </div>
                          <div>
                            <Label htmlFor="inspectionNotes">Notes</Label>
                            <Textarea
                              id="inspectionNotes"
                              placeholder="Add any special instructions or notes about the inspection..."
                              value={inspectionNotes}
                              onChange={(e) => setInspectionNotes(e.target.value)}
                              rows={3}
                              data-testid="input-inspection-notes"
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            onClick={() => moveToInspectionMutation.mutate({ scheduledDate: inspectionDate, notes: inspectionNotes })}
                            disabled={moveToInspectionMutation.isPending || !inspectionDate}
                            data-testid="button-confirm-schedule-inspection"
                          >
                            Schedule Inspection
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}

                  {/* Complete Inspection */}
                  {currentStatus === 'site_inspection_scheduled' && (
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button variant="outline" className="w-full" data-testid="button-complete-inspection">
                          <ClipboardCheck className="w-4 h-4 mr-2" />
                          Complete Inspection
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                          <DialogTitle>Complete Site Inspection</DialogTitle>
                          <DialogDescription>
                            Record your findings from the site inspection and choose an outcome
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-6">
                          {/* Inspection Checklist */}
                          <div className="space-y-4">
                            <Label className="text-base font-semibold">Inspection Checklist</Label>
                            
                            {/* Room Count Verification */}
                            <div className="space-y-2 p-3 border rounded-md">
                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="roomCountVerified"
                                  checked={roomCountVerified}
                                  onCheckedChange={(checked) => setRoomCountVerified(!!checked)}
                                  data-testid="checkbox-room-count"
                                />
                                <Label htmlFor="roomCountVerified" className="font-medium cursor-pointer">
                                  Room count verified (Declared: {app.totalRooms})
                                </Label>
                              </div>
                              <Input
                                placeholder="Actual room count (if different)"
                                value={roomCountActual}
                                onChange={(e) => setRoomCountActual(e.target.value)}
                                type="number"
                                data-testid="input-room-count-actual"
                              />
                            </div>
                            
                            {/* Amenities Verification */}
                            <div className="space-y-2 p-3 border rounded-md">
                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="amenitiesVerified"
                                  checked={amenitiesVerified}
                                  onCheckedChange={(checked) => setAmenitiesVerified(!!checked)}
                                  data-testid="checkbox-amenities"
                                />
                                <Label htmlFor="amenitiesVerified" className="font-medium cursor-pointer">
                                  Amenities verified (as per {app.category} category)
                                </Label>
                              </div>
                              <Textarea
                                placeholder="Issues with amenities (if any)..."
                                value={amenitiesIssues}
                                onChange={(e) => setAmenitiesIssues(e.target.value)}
                                rows={2}
                                data-testid="input-amenities-issues"
                              />
                            </div>
                            
                            {/* Fire Safety Verification */}
                            <div className="space-y-2 p-3 border rounded-md">
                              <div className="flex items-center space-x-2">
                                <Checkbox
                                  id="fireSafetyVerified"
                                  checked={fireSafetyVerified}
                                  onCheckedChange={(checked) => setFireSafetyVerified(!!checked)}
                                  data-testid="checkbox-fire-safety"
                                />
                                <Label htmlFor="fireSafetyVerified" className="font-medium cursor-pointer">
                                  Fire safety measures verified
                                </Label>
                              </div>
                              <Textarea
                                placeholder="Fire safety issues (if any)..."
                                value={fireSafetyIssues}
                                onChange={(e) => setFireSafetyIssues(e.target.value)}
                                rows={2}
                                data-testid="input-fire-safety-issues"
                              />
                            </div>
                          </div>
                          
                          {/* Category Recommendation */}
                          <div className="space-y-2">
                            <Label htmlFor="categoryRec">Category Recommendation (Optional)</Label>
                            <Input
                              id="categoryRec"
                              placeholder="Recommend different category if needed"
                              value={categoryRecommendation}
                              onChange={(e) => setCategoryRecommendation(e.target.value)}
                              data-testid="input-category-recommendation"
                            />
                          </div>
                          
                          {/* Inspection Outcome */}
                          <div className="space-y-3">
                            <Label className="text-base font-semibold">Inspection Outcome</Label>
                            <RadioGroup value={inspectionOutcome} onValueChange={(value: any) => setInspectionOutcome(value)}>
                              <div className="flex items-center space-x-2 p-3 border rounded-md hover-elevate cursor-pointer">
                                <RadioGroupItem value="approved" id="outcome-approved" data-testid="radio-approved" />
                                <Label htmlFor="outcome-approved" className="flex-1 cursor-pointer">
                                  <span className="font-medium text-green-600">Approve</span>
                                  <p className="text-sm text-muted-foreground">Site inspection successful, move to payment</p>
                                </Label>
                              </div>
                              <div className="flex items-center space-x-2 p-3 border rounded-md hover-elevate cursor-pointer">
                                <RadioGroupItem value="corrections_needed" id="outcome-corrections" data-testid="radio-corrections" />
                                <Label htmlFor="outcome-corrections" className="flex-1 cursor-pointer">
                                  <span className="font-medium text-orange-600">Send Back for Corrections</span>
                                  <p className="text-sm text-muted-foreground">Issues found, applicant needs to fix them</p>
                                </Label>
                              </div>
                              <div className="flex items-center space-x-2 p-3 border rounded-md hover-elevate cursor-pointer">
                                <RadioGroupItem value="rejected" id="outcome-rejected" data-testid="radio-rejected" />
                                <Label htmlFor="outcome-rejected" className="flex-1 cursor-pointer">
                                  <span className="font-medium text-destructive">Reject</span>
                                  <p className="text-sm text-muted-foreground">Property does not meet requirements</p>
                                </Label>
                              </div>
                            </RadioGroup>
                          </div>
                          
                          {/* Issues Found (required for corrections/rejection) */}
                          {(inspectionOutcome === 'corrections_needed' || inspectionOutcome === 'rejected') && (
                            <div className="space-y-2">
                              <Label htmlFor="issuesFound" className="text-destructive">Issues Found *</Label>
                              <Textarea
                                id="issuesFound"
                                placeholder="Describe the issues that need to be addressed..."
                                value={issuesFound}
                                onChange={(e) => setIssuesFound(e.target.value)}
                                rows={4}
                                data-testid="input-issues-found"
                                className="border-destructive"
                              />
                            </div>
                          )}
                          
                          {/* Additional Notes */}
                          <div className="space-y-2">
                            <Label htmlFor="completionNotes">Additional Notes</Label>
                            <Textarea
                              id="completionNotes"
                              placeholder="Any additional observations or recommendations..."
                              value={inspectionCompletionNotes}
                              onChange={(e) => setInspectionCompletionNotes(e.target.value)}
                              rows={3}
                              data-testid="input-inspection-completion-notes"
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            onClick={() => completeInspectionMutation.mutate()}
                            disabled={completeInspectionMutation.isPending || 
                              ((inspectionOutcome === 'corrections_needed' || inspectionOutcome === 'rejected') && !issuesFound)}
                            data-testid="button-confirm-complete-inspection"
                          >
                            {completeInspectionMutation.isPending ? "Processing..." : "Submit Inspection Results"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}

                  {/* Info message if no actions available */}
                  {currentStatus !== 'submitted' && 
                   currentStatus !== 'document_verification' && 
                   currentStatus !== 'site_inspection_scheduled' && (
                    <div className="text-sm text-muted-foreground p-4 border rounded-md">
                      No workflow actions available for current status. Use the Review section above to approve or reject.
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar - Fee Summary */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <IndianRupee className="w-5 h-5 text-primary" />
                  <CardTitle>Fee Summary</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Annual Registration Fee</span>
                  <span data-testid="text-base-fee">₹{Number(app.baseFee ?? 0).toFixed(2)}</span>
                </div>
                <div className="space-y-1 text-sm mt-3 border-t pt-3">
                  {Number(app.femaleOwnerDiscount) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Female Owner Discount</span>
                      <span className="text-green-600">-₹{Number(app.femaleOwnerDiscount).toFixed(2)}</span>
                    </div>
                  )}
                  {Number(app.pangiDiscount) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Pangi Sub-division Discount</span>
                      <span className="text-green-600">-₹{Number(app.pangiDiscount).toFixed(2)}</span>
                    </div>
                  )}
                  {Number(app.validityDiscount) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Validity Discount</span>
                      <span className="text-green-600">-₹{Number(app.validityDiscount).toFixed(2)}</span>
                    </div>
                  )}
                  {Number(app.totalDiscount) > 0 && (
                    <div className="flex justify-between font-medium text-sm">
                      <span className="text-muted-foreground">Total Discount</span>
                      <span className="text-green-700">-₹{Number(app.totalDiscount).toFixed(2)}</span>
                    </div>
                  )}
                </div>
                <div className="pt-3 border-t flex justify-between font-semibold">
                  <span>Total Payable</span>
                  <span className="text-primary" data-testid="text-total">₹{Number(app.totalFee ?? app.baseFee).toFixed(2)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  HP Tourism Policy 2025 collects a single consolidated fee (no per-room add-ons or GST line items).
                </p>
              </CardContent>
            </Card>

            <InspectionReportCard applicationId={applicationId ?? null} />

            <ApplicationTimelineCard
              applicationId={applicationId ?? null}
              description="Tracks DA, DTDO, and owner actions for this application."
            />

            {!isPropertyOwner && (app.districtNotes || app.stateNotes) && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <FileText className="w-5 h-5 text-primary" />
                    <CardTitle>Officer Comments</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {app.districtNotes && (
                    <div>
                      <Label className="text-muted-foreground text-xs">District Officer</Label>
                      <p className="text-sm" data-testid="text-district-notes">{app.districtNotes}</p>
                    </div>
                  )}
                  {app.stateNotes && (
                    <div>
                      <Label className="text-muted-foreground text-xs">State Officer</Label>
                      <p className="text-sm" data-testid="text-state-notes">{app.stateNotes}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
      
      {/* Image Gallery Modal */}
      {(() => {
        const propertyPhotos = documentsData?.documents?.filter(
          doc => doc.documentType === 'property_photo' && doc.mimeType.startsWith('image/')
        ) || [];
        
        return (
          <ImageGallery
            images={propertyPhotos.map(photo => ({
              filePath: photo.filePath,
              fileName: photo.fileName,
              mimeType: photo.mimeType,
            }))}
            open={isGalleryOpen}
            onClose={() => setIsGalleryOpen(false)}
            initialIndex={galleryInitialIndex}
          />
        );
      })()}
    </div>
    </>
  );
}
