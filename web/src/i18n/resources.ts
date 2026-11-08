import zhreferenceWebResearch from './catalogs/zh-CN/referenceWebResearch';
import enreferenceWebResearch from './catalogs/en/referenceWebResearch';
import zhreferenceAppProposal from './catalogs/zh-CN/referenceAppProposal';
import enreferenceAppProposal from './catalogs/en/referenceAppProposal';
import zhreferencePackagedSkills from './catalogs/zh-CN/referencePackagedSkills';
import enreferencePackagedSkills from './catalogs/en/referencePackagedSkills';
import zhreferenceStarterTemplates from './catalogs/zh-CN/referenceStarterTemplates';
import enreferenceStarterTemplates from './catalogs/en/referenceStarterTemplates';
import zhreferenceUpdates from './catalogs/zh-CN/referenceUpdates';
import enreferenceUpdates from './catalogs/en/referenceUpdates';
import zhreferenceRoutineTransfer from './catalogs/zh-CN/referenceRoutineTransfer';
import enreferenceRoutineTransfer from './catalogs/en/referenceRoutineTransfer';
import zhreferenceProviders from './catalogs/zh-CN/referenceProviders';
import enreferenceProviders from './catalogs/en/referenceProviders';
import zhreferenceVoice from './catalogs/zh-CN/referenceVoice';
import enreferenceVoice from './catalogs/en/referenceVoice';
import zhreferenceNotifications from './catalogs/zh-CN/referenceNotifications';
import enreferenceNotifications from './catalogs/en/referenceNotifications';
import zhreferenceAppPolicies from './catalogs/zh-CN/referenceAppPolicies';
import enreferenceAppPolicies from './catalogs/en/referenceAppPolicies';
import zhreferenceTeaching from './catalogs/zh-CN/referenceTeaching';
import enreferenceTeaching from './catalogs/en/referenceTeaching';
import zhreferenceUsage from './catalogs/zh-CN/referenceUsage';
import enreferenceUsage from './catalogs/en/referenceUsage';
import zhreferenceSettings from './catalogs/zh-CN/referenceSettings';
import enreferenceSettings from './catalogs/en/referenceSettings';
import zhreferenceFiles from './catalogs/zh-CN/referenceFiles';
import enreferenceFiles from './catalogs/en/referenceFiles';
import zhreferenceNewChat from './catalogs/zh-CN/referenceNewChat';
import enreferenceNewChat from './catalogs/en/referenceNewChat';
import zhreferenceComposer from './catalogs/zh-CN/referenceComposer';
import enreferenceComposer from './catalogs/en/referenceComposer';
import zhreferenceDetails from './catalogs/zh-CN/referenceDetails';
import enreferenceDetails from './catalogs/en/referenceDetails';
import zhExtra from './catalogs/zh-CN/supplements';
import enExtra from './catalogs/en/supplements';
import zh0 from './catalogs/zh-CN/account-01.json';
import en0 from './catalogs/en/account-01.json';
import zh1 from './catalogs/zh-CN/account-02.json';
import en1 from './catalogs/en/account-02.json';
import zh2 from './catalogs/zh-CN/account-03.json';
import en2 from './catalogs/en/account-03.json';
import zh3 from './catalogs/zh-CN/apps-01.json';
import en3 from './catalogs/en/apps-01.json';
import zh4 from './catalogs/zh-CN/apps-02.json';
import en4 from './catalogs/en/apps-02.json';
import zh5 from './catalogs/zh-CN/bots-01.json';
import en5 from './catalogs/en/bots-01.json';
import zh6 from './catalogs/zh-CN/bots-02.json';
import en6 from './catalogs/en/bots-02.json';
import zh7 from './catalogs/zh-CN/bots-03.json';
import en7 from './catalogs/en/bots-03.json';
import zh8 from './catalogs/zh-CN/bots-04.json';
import en8 from './catalogs/en/bots-04.json';
import zh9 from './catalogs/zh-CN/common-01.json';
import en9 from './catalogs/en/common-01.json';
import zh10 from './catalogs/zh-CN/common-02.json';
import en10 from './catalogs/en/common-02.json';
import zh11 from './catalogs/zh-CN/common-03.json';
import en11 from './catalogs/en/common-03.json';
import zh12 from './catalogs/zh-CN/common-04.json';
import en12 from './catalogs/en/common-04.json';
import zh13 from './catalogs/zh-CN/computer-01.json';
import en13 from './catalogs/en/computer-01.json';
import zh14 from './catalogs/zh-CN/computer-02.json';
import en14 from './catalogs/en/computer-02.json';
import zh15 from './catalogs/zh-CN/computer-03.json';
import en15 from './catalogs/en/computer-03.json';
import zh16 from './catalogs/zh-CN/computer-04.json';
import en16 from './catalogs/en/computer-04.json';
import zh17 from './catalogs/zh-CN/platform-01.json';
import en17 from './catalogs/en/platform-01.json';
import zh18 from './catalogs/zh-CN/platform-02.json';
import en18 from './catalogs/en/platform-02.json';
import zh19 from './catalogs/zh-CN/routines-01.json';
import en19 from './catalogs/en/routines-01.json';
import zh20 from './catalogs/zh-CN/routines-02.json';
import en20 from './catalogs/en/routines-02.json';
import zh21 from './catalogs/zh-CN/settings-01.json';
import en21 from './catalogs/en/settings-01.json';
import zh22 from './catalogs/zh-CN/settings-02.json';
import en22 from './catalogs/en/settings-02.json';
import zh23 from './catalogs/zh-CN/workspace-01.json';
import en23 from './catalogs/en/workspace-01.json';
import zh24 from './catalogs/zh-CN/workspace-02.json';
import en24 from './catalogs/en/workspace-02.json';
export const uiResources = {
  'zh-CN': {
    account: { ...zh0, ...zh1, ...zh2, ...zhExtra.account },
    apps: { ...zh3, ...zh4, ...zhExtra.apps },
    bots: { ...zh5, ...zh6, ...zh7, ...zh8, ...zhExtra.bots },
    common: { ...zh9, ...zh10, ...zh11, ...zh12, ...zhExtra.common },
    computer: { ...zh13, ...zh14, ...zh15, ...zh16, ...zhExtra.computer },
    platform: { ...zh17, ...zh18, ...zhExtra.platform },
    routines: { ...zh19, ...zh20, ...zhExtra.routines },
    settings: { ...zh21, ...zh22, ...zhExtra.settings },
    workspace: {
      ...zh23,
      ...zh24,
      ...zhExtra.workspace,
      ...zhreferenceDetails,
      ...zhreferenceComposer,
      ...zhreferenceNewChat,
      ...zhreferenceFiles,
      ...zhreferenceSettings,
      ...zhreferenceUsage,
      ...zhreferenceNotifications,
      ...zhreferenceAppPolicies,
      ...zhreferenceTeaching,
      ...zhreferenceVoice,
      ...zhreferenceProviders,
      ...zhreferenceRoutineTransfer,
      ...zhreferenceUpdates,
      ...zhreferenceStarterTemplates,
      ...zhreferenceAppProposal,
      ...zhreferencePackagedSkills,
      ...zhreferenceWebResearch,
    },
  },
  en: {
    account: { ...en0, ...en1, ...en2, ...enExtra.account },
    apps: { ...en3, ...en4, ...enExtra.apps },
    bots: { ...en5, ...en6, ...en7, ...en8, ...enExtra.bots },
    common: { ...en9, ...en10, ...en11, ...en12, ...enExtra.common },
    computer: { ...en13, ...en14, ...en15, ...en16, ...enExtra.computer },
    platform: { ...en17, ...en18, ...enExtra.platform },
    routines: { ...en19, ...en20, ...enExtra.routines },
    settings: { ...en21, ...en22, ...enExtra.settings },
    workspace: {
      ...en23,
      ...en24,
      ...enExtra.workspace,
      ...enreferenceDetails,
      ...enreferenceComposer,
      ...enreferenceNewChat,
      ...enreferenceFiles,
      ...enreferenceSettings,
      ...enreferenceUsage,
      ...enreferenceNotifications,
      ...enreferenceAppPolicies,
      ...enreferenceTeaching,
      ...enreferenceVoice,
      ...enreferenceProviders,
      ...enreferenceRoutineTransfer,
      ...enreferenceUpdates,
      ...enreferenceStarterTemplates,
      ...enreferenceAppProposal,
      ...enreferencePackagedSkills,
      ...enreferenceWebResearch,
    },
  },
};
