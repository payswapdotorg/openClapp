import {
  ArrowRight,
  ChevronLeft,
  FileText,
  Layers,
  type LucideIcon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import type { ClappPlatform } from "../../../packages/clapp-contracts/src/index.ts";
import {
  advanceStateFrom,
  artifactLinksFrom,
  type ClappAdvanceResultWire,
  type ClappAdvanceState,
  type ClappArtifactLink,
  type ClappChipStatus,
  type ClappControlActionWire,
  type ClappControlResultWire,
  type ClappCreateFormInput,
  type ClappCreateResultWire,
  type ClappListEntryWire,
  type ClappReconstructionListItem,
  type ClappStageChip,
  type ClappStatusWire,
  clappCreateRequestFrom,
  clappErrorText,
  controlActionsFor,
  reconstructionListFrom,
  refreshPolicyFrom,
  stageChainFrom,
} from "./clapp-view-models";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  LinkRow,
  relativeDate,
  SectionHeading,
  Sheet,
  s,
} from "./ui";
import { useWorkspace } from "./workspace";

/**
 * CLAPP-W3-007 — the CLAPP UX surfaces over the /api/clapp HTTP surface.
 *
 * These screens are pure consumers: every read and every mutation goes
 * through the app's own MuseApi conventions (same token/session handling as
 * every other screen), there is no server code imported, no domain logic in
 * the JSX (the view-models derive everything), and no state machines beyond
 * local view state. Honesty rules: loading states are explicit, failures
 * surface the server's message verbatim, the stage chain renders exactly
 * what the status endpoint reported, artifacts open by their signed
 * contentUrls, and every refresh is a real re-fetch — nothing optimistic.
 */

const PLATFORMS: readonly ClappPlatform[] = ["web", "android", "linux", "windows", "macos", "ios"];
const RETENTIONS: readonly ClappCreateFormInput["retention"][] = [
  "ephemeral",
  "project",
  "library",
];
const PACKAGE_POLICIES: readonly ClappCreateFormInput["packagePolicy"][] = [
  "verified-only",
  "verified-and-candidates",
];

const CONTROL_ICONS: Record<ClappControlActionWire, LucideIcon> = {
  pause: Pause,
  resume: Play,
  cancel: Square,
  retry: RotateCw,
};

const CONTROL_LABELS: Record<ClappControlActionWire, string> = {
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Retry",
};

/** Presentation-only tints; the statuses themselves come from the view-model. */
const CHIP_TINTS: Record<string, string> = {
  pending: colors.orange,
  running: colors.blue,
  waiting_input: colors.orange,
  waiting_approval: colors.orange,
  succeeded: colors.green,
  failed: "#FBEFED",
  cancelled: "#FBEFED",
  skipped: colors.lavender,
  not_started: colors.line,
  unknown: colors.lavender,
  mixed: colors.lavender,
  paused: colors.orange,
};

const chipTint = (status: string): string => CHIP_TINTS[status] ?? colors.lavender;

const splitList = (text: string): string[] =>
  text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const positiveInt = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const nonNegativeInt = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

/** The CLAPP navigator: list ⇄ detail, held in local view state only. */
export function ClappScreen() {
  const [target, setTarget] = useState<{ view: "list" } | { view: "detail"; id: string }>({
    view: "list",
  });
  if (target.view === "detail") {
    return <ClappDetailScreen id={target.id} onBack={() => setTarget({ view: "list" })} />;
  }
  return <ClappListScreen onOpen={(id) => setTarget({ view: "detail", id })} />;
}

// ---------------------------------------------------------------------------
// The list screen
// ---------------------------------------------------------------------------

export function ClappListScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { api } = useWorkspace();
  const [entries, setEntries] = useState<ClappListEntryWire[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<ClappListEntryWire[]>("/api/clapp/reconstructions")
      .then((items) => {
        if (active) setEntries(items);
      })
      .catch((cause: unknown) => {
        if (active) setError(clappErrorText(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, reload]);
  const items = entries ? reconstructionListFrom(entries) : undefined;
  return (
    <View style={{ gap: 18 }}>
      <SectionHeading
        title="CLAPP reconstructions"
        action="Refresh"
        onPress={() => setReload((count) => count + 1)}
      />
      <ErrorNotice error={error} />
      {loading && !items ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : items ? (
        items.length === 0 ? (
          <Empty
            icon={Layers}
            title="No reconstructions yet"
            detail="Create one to authorize and reconstruct a target application through the CLAPP stage chain."
          >
            <Button primary icon={Plus} onPress={() => setCreating(true)}>
              New reconstruction
            </Button>
          </Empty>
        ) : (
          items.map((item) => <ClappListRow key={item.id} item={item} onOpen={onOpen} />)
        )
      ) : null}
      {items && items.length > 0 && (
        <Button primary icon={Plus} onPress={() => setCreating(true)}>
          New reconstruction
        </Button>
      )}
      {creating && (
        <ClappCreateSheet
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setReload((count) => count + 1);
          }}
        />
      )}
    </View>
  );
}

function ClappListRow({
  item,
  onOpen,
}: {
  item: ClappReconstructionListItem;
  onOpen: (id: string) => void;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={() => onOpen(item.id)}>
      <Card style={{ gap: 10 }}>
        <View style={[s.between, { gap: 10 }]}>
          <Text style={[s.text, { fontWeight: "600", flexShrink: 1 }]}>{item.name}</Text>
          <Chip tint={item.complete ? colors.green : chipTint("pending")}>
            {item.runStatusLabel}
          </Chip>
        </View>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Chip tint={colors.sky}>{item.platform}</Chip>
          {item.cancelled && <Chip tint={"#FBEFED"}>Cancelled</Chip>}
          {item.complete && <Chip tint={colors.green}>Complete</Chip>}
        </View>
        <Text style={s.small}>{item.statusDetail}</Text>
        <Text style={s.small}>Created {relativeDate(item.createdAt)}</Text>
      </Card>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// The create sheet
// ---------------------------------------------------------------------------

function ClappCreateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { api, notify } = useWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<ClappPlatform>("web");
  const [targetId, setTargetId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [entrypoints, setEntrypoints] = useState("");
  const [scope, setScope] = useState("");
  const [environments, setEnvironments] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [retention, setRetention] = useState<ClappCreateFormInput["retention"]>("project");
  const [benchmarkOwned, setBenchmarkOwned] = useState(true);
  const [maxStages, setMaxStages] = useState("6");
  const [maxActions, setMaxActions] = useState("200");
  const [maxDurationMs, setMaxDurationMs] = useState("900000");
  const [seed, setSeed] = useState("7");
  const [targetStack, setTargetStack] = useState("");
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [packagePolicy, setPackagePolicy] =
    useState<ClappCreateFormInput["packagePolicy"]>("verified-only");
  const [journeys, setJourneys] = useState("");
  const [visual, setVisual] = useState(true);
  const [network, setNetwork] = useState(false);
  const [verifyState, setVerifyState] = useState(true);
  const [maxRepairIterations, setMaxRepairIterations] = useState("2");

  const entrypointList = splitList(entrypoints);
  const scopeList = splitList(scope);
  const environmentList = splitList(environments);
  const missing =
    !name.trim() ||
    !targetId.trim() ||
    !ownerId.trim() ||
    entrypointList.length === 0 ||
    scopeList.length === 0 ||
    environmentList.length === 0 ||
    !targetStack.trim();

  function submit() {
    setError("");
    const parsedStages = positiveInt(maxStages);
    const parsedActions = positiveInt(maxActions);
    const parsedDuration = positiveInt(maxDurationMs);
    const parsedSeed = Number(seed);
    const parsedRepair = nonNegativeInt(maxRepairIterations);
    if (parsedStages === null) {
      setError("exploration.maxStages must be a positive integer");
      return;
    }
    if (parsedActions === null) {
      setError("exploration.maxActions must be a positive integer");
      return;
    }
    if (parsedDuration === null) {
      setError("exploration.maxDurationMs must be a positive integer");
      return;
    }
    if (!Number.isFinite(parsedSeed)) {
      setError("exploration.seed must be a finite number");
      return;
    }
    if (parsedRepair === null) {
      setError("verification.maxRepairIterations must be a non-negative integer");
      return;
    }
    const form: ClappCreateFormInput = {
      reconstructionId: `clapp_draft_${Date.now().toString(36)}`,
      name: name.trim(),
      platform,
      targetId: targetId.trim(),
      entrypoints: entrypointList,
      ownerId: ownerId.trim(),
      scope: scopeList,
      environments: environmentList,
      ...(expiresAt.trim() ? { expiresAt: expiresAt.trim() } : {}),
      retention,
      benchmarkOwned,
      authorizationCreatedAt: new Date().toISOString(),
      maxStages: parsedStages,
      maxActions: parsedActions,
      maxDurationMs: parsedDuration,
      seed: parsedSeed,
      targetStack: targetStack.trim(),
      allowNetwork,
      packagePolicy,
      journeys: splitList(journeys),
      visual,
      network,
      state: verifyState,
      maxRepairIterations: parsedRepair,
    };
    const body = clappCreateRequestFrom(form);
    setBusy(true);
    void api
      .request<ClappCreateResultWire>("/api/clapp/reconstructions", body)
      .then((result) => {
        notify(`Reconstruction created — ${result.reconstruction.id}`);
        onCreated();
      })
      .catch((cause: unknown) => {
        setError(clappErrorText(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  return (
    <Sheet
      title="New reconstruction"
      subtitle="The server validates the full spec strictly and rejects anything incomplete."
      onClose={onClose}
    >
      <ErrorNotice error={error} />
      <Field label="Name" value={name} onChangeText={setName} placeholder="My app reconstruction" />
      <View style={s.field}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Platform</Text>
        <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
          {PLATFORMS.map((item) => (
            <Button key={item} small primary={platform === item} onPress={() => setPlatform(item)}>
              {item}
            </Button>
          ))}
        </View>
      </View>
      <Field
        label="Target id"
        value={targetId}
        onChangeText={setTargetId}
        placeholder="The authorized target application"
      />
      <Field
        label="Owner id"
        value={ownerId}
        onChangeText={setOwnerId}
        placeholder="Must be your workspace owner id"
      />
      <Field
        label="Entrypoints (comma-separated)"
        value={entrypoints}
        onChangeText={setEntrypoints}
        placeholder="https://example.com, https://example.com/login"
      />
      <Field
        label="Scope (comma-separated)"
        value={scope}
        onChangeText={setScope}
        placeholder="read:screens, read:network"
      />
      <Field
        label="Environments (comma-separated)"
        value={environments}
        onChangeText={setEnvironments}
        placeholder="staging"
      />
      <Field
        label="Authorization expires at (optional)"
        value={expiresAt}
        onChangeText={setExpiresAt}
        placeholder="Leave empty for no expiry"
      />
      <View style={s.field}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Retention</Text>
        <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
          {RETENTIONS.map((item) => (
            <Button
              key={item}
              small
              primary={retention === item}
              onPress={() => setRetention(item)}
            >
              {item}
            </Button>
          ))}
        </View>
      </View>
      <CheckRow
        label="Benchmark-owned authorization"
        checked={benchmarkOwned}
        onPress={() => setBenchmarkOwned(!benchmarkOwned)}
      />
      <Field label="Exploration max stages" value={maxStages} onChangeText={setMaxStages} />
      <Field label="Exploration max actions" value={maxActions} onChangeText={setMaxActions} />
      <Field
        label="Exploration max duration (ms)"
        value={maxDurationMs}
        onChangeText={setMaxDurationMs}
      />
      <Field label="Exploration seed" value={seed} onChangeText={setSeed} />
      <Field
        label="Target stack"
        value={targetStack}
        onChangeText={setTargetStack}
        placeholder="nextjs-typescript-tailwind"
      />
      <CheckRow
        label="Allow network during synthesis"
        checked={allowNetwork}
        onPress={() => setAllowNetwork(!allowNetwork)}
      />
      <View style={s.field}>
        <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>Package policy</Text>
        <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
          {PACKAGE_POLICIES.map((item) => (
            <Button
              key={item}
              small
              primary={packagePolicy === item}
              onPress={() => setPackagePolicy(item)}
            >
              {item}
            </Button>
          ))}
        </View>
      </View>
      <Field
        label="Verification journeys (comma-separated, optional)"
        value={journeys}
        onChangeText={setJourneys}
        placeholder="sign-in, check-out"
      />
      <CheckRow label="Visual verification" checked={visual} onPress={() => setVisual(!visual)} />
      <CheckRow
        label="Network verification"
        checked={network}
        onPress={() => setNetwork(!network)}
      />
      <CheckRow
        label="State verification"
        checked={verifyState}
        onPress={() => setVerifyState(!verifyState)}
      />
      <Field
        label="Max repair iterations"
        value={maxRepairIterations}
        onChangeText={setMaxRepairIterations}
      />
      <Button primary busy={busy} disabled={missing} onPress={submit}>
        Create reconstruction
      </Button>
      {missing && (
        <Text style={s.small}>
          Name, target id, owner id, at least one entrypoint, scope and environment, and a target
          stack are required.
        </Text>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The detail screen
// ---------------------------------------------------------------------------

export function ClappDetailScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { api, notify } = useWorkspace();
  const [status, setStatus] = useState<ClappStatusWire>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<ClappStatusWire>(`/api/clapp/reconstructions/${encodeURIComponent(id)}`)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(clappErrorText(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, id, reload]);
  const policy = status ? refreshPolicyFrom(status) : null;
  useEffect(() => {
    if (!policy || policy.intervalMs === null) return;
    const timer = setInterval(() => setReload((count) => count + 1), policy.intervalMs);
    return () => clearInterval(timer);
  }, [policy?.intervalMs]);

  async function control(action: ClappControlActionWire) {
    setActing(true);
    setError("");
    try {
      const result = await api.request<ClappControlResultWire>(
        `/api/clapp/reconstructions/${encodeURIComponent(id)}/control`,
        { action },
      );
      notify(
        `${CONTROL_LABELS[action]} accepted — task ${result.task.id} is ${result.task.status}`,
      );
      setReload((count) => count + 1);
    } catch (cause: unknown) {
      setError(clappErrorText(cause));
    } finally {
      setActing(false);
    }
  }

  async function advance() {
    setActing(true);
    setError("");
    try {
      const result = await api.request<ClappAdvanceResultWire>(
        `/api/clapp/reconstructions/${encodeURIComponent(id)}/advance`,
        {},
      );
      notify(result.reason);
      setReload((count) => count + 1);
    } catch (cause: unknown) {
      setError(clappErrorText(cause));
    } finally {
      setActing(false);
    }
  }

  const chips = status ? stageChainFrom(status) : [];
  const actions = status ? controlActionsFor(status) : [];
  const links = status ? artifactLinksFrom(status) : [];
  const advanceState = status ? advanceStateFrom(status) : null;
  return (
    <View style={{ gap: 18 }}>
      <View style={[s.row, { gap: 10 }]}>
        <Button small icon={ChevronLeft} onPress={onBack}>
          Back
        </Button>
        <Button small icon={RefreshCw} onPress={() => setReload((count) => count + 1)}>
          Refresh
        </Button>
      </View>
      <ErrorNotice error={error} />
      {loading && !status ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : status ? (
        <>
          <Card style={{ gap: 10 }}>
            <Text style={[s.heading, { flexShrink: 1 }]}>{status.reconstruction.spec.name}</Text>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Chip tint={colors.sky}>{status.reconstruction.spec.platform}</Chip>
              <Chip tint={chipTint(status.run.runStatus)}>{status.run.runStatus}</Chip>
              {status.complete && <Chip tint={colors.green}>Complete</Chip>}
              {status.reconstruction.status === "cancelled" && (
                <Chip tint={"#FBEFED"}>Cancelled</Chip>
              )}
            </View>
            <Text style={s.small}>{status.reconstruction.id}</Text>
            <Text style={s.small}>Created {relativeDate(status.reconstruction.createdAt)}</Text>
          </Card>
          <SectionHeading title="Stage chain" />
          {policy && <Text style={s.small}>{policy.label}</Text>}
          {chips.map((chip) => (
            <ClappStageRow key={chip.stage} chip={chip} />
          ))}
          {status.run.malformed > 0 && (
            <Text style={s.small}>
              {status.run.malformed} task(s) could not be attributed to the chain — counted by the
              server, shown as reported.
            </Text>
          )}
          <SectionHeading title="Controls" />
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {actions.map((action) => (
              <Button
                key={action}
                small
                danger={action === "cancel"}
                icon={CONTROL_ICONS[action]}
                busy={acting}
                onPress={() => void control(action)}
              >
                {CONTROL_LABELS[action]}
              </Button>
            ))}
            {actions.length === 0 && (
              <Text style={s.small}>No control actions are valid right now.</Text>
            )}
          </View>
          {advanceState && (
            <>
              <Button
                icon={ArrowRight}
                disabled={!advanceState.enabled}
                busy={acting}
                onPress={() => void advance()}
              >
                Advance to the next stage
              </Button>
              <Text style={s.small}>{advanceState.hint}</Text>
            </>
          )}
          <SectionHeading title="Artifacts" />
          {links.length === 0 ? (
            <Text style={s.muted}>No artifacts have been published yet.</Text>
          ) : (
            links.map((link) => <ClappArtifactRow key={link.id} link={link} />)
          )}
        </>
      ) : (
        !loading && <Text style={s.muted}>No status has been received yet.</Text>
      )}
    </View>
  );
}

function ClappStageRow({ chip }: { chip: ClappStageChip }) {
  return (
    <Card style={{ gap: 8, paddingVertical: 14 }}>
      <View style={[s.between, { gap: 10 }]}>
        <Text style={[s.text, { fontWeight: "600" }]}>{chip.label}</Text>
        <Chip tint={chipTint(chip.status)}>{chip.statusLabel}</Chip>
      </View>
      <Text style={s.small}>
        {chip.reported
          ? `${chip.attempts ?? "?"} attempt(s) · ${chip.artifactCount} artifact(s)`
          : `${chip.artifactCount} artifact(s)`}
      </Text>
      {chip.error && <Text style={[s.small, { color: colors.danger }]}>{chip.error}</Text>}
    </Card>
  );
}

function ClappArtifactRow({ link }: { link: ClappArtifactLink }) {
  const { api } = useWorkspace();
  return (
    <LinkRow
      icon={FileText}
      title={link.name}
      detail={`${link.classification}${link.redacted ? " · redacted" : ""}`}
      onPress={() => void Linking.openURL(api.url(link.url))}
    />
  );
}

// Re-exported for the registry consumers: the chip status union is part of the
// screens' public typing surface.
export type { ClappAdvanceState, ClappChipStatus };
