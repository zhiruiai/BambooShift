import { uiText } from '../i18n';
import { Dialog } from './UI';
import { TeachingPanel } from './TeachingPanel';
import { ComputerConnectionSettingsView } from './computer/ComputerConnectionSettingsView';
import { ComputerScreenView } from './computer/ComputerScreenView';
import { ComputerStatusView } from './computer/ComputerStatusView';
import type { ComputerDialogProps } from './computer/types';
import { useComputerDialog } from './computer/useComputerDialog';
export function ComputerDialog(props: ComputerDialogProps) {
  const model = useComputerDialog(props);
  const { agent, isDesktop, desktopScreenLabel, finish } = model;
  return (
    <Dialog
      title={
        agent
          ? uiText('computer:text_6b5ccce487c4', { value0: agent.name })
          : uiText('computer:text_6205c8a9a2b9')
      }
      subtitle={
        isDesktop
          ? uiText('computer:text_3c131ec4b8fe', { value0: desktopScreenLabel })
          : uiText('computer:text_d7640e570704')
      }
      onClose={() => {
        void finish(true);
      }}
      wide
      className="computer-dialog"
    >
      <ComputerConnectionSettingsView {...model} />
      <ComputerStatusView {...model} />
      <ComputerScreenView {...model} />
      <TeachingPanel
        agent={agent}
        conversationId={props.conversationId}
        leaseId={model.leaseRef.current?.leaseId}
        screenReady={model.screenReady}
        busy={props.busy || model.inputBusy}
        eligible={model.teachingEligible}
        binding={model.teachingBinding}
        onInputBlocked={model.updateTeachingBlocked}
        skills={props.data.skills}
        refresh={props.refresh}
      />
    </Dialog>
  );
}
