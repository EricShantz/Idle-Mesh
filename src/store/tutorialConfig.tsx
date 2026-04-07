import type { ComponentType, ReactNode } from 'react';
import {
  PublisherGraphic,
  EventsFlowGraphic,
  EarnMoneyGraphic,
  UpgradeExpandGraphic,
  BrokerUpgradeGraphic,
  QueueGraphic,
  DmqGraphic,
  MultiPublisherGraphic,
  MultiSubscriberGraphic,
  MultiBrokerGraphic,
  EventDropGraphic,
} from '../components/TutorialGraphics';

export type TutorialSlide = {
  title: string;
  body: ReactNode;
  graphic?: ComponentType;
};

export type TutorialDef = {
  key: string;
  slides: TutorialSlide[];
};

export const tutorials: TutorialDef[] = [
  {
    key: 'intro',
    slides: [
      { title: 'Welcome to Idle Mesh!', body: 'Click the "Publisher" to send events into your event mesh.', graphic: PublisherGraphic },
      { title: 'Events Flow Through the Mesh', body: 'Events travel from publishers to subscribers.', graphic: EventsFlowGraphic },
      { title: 'Earn Money', body: 'When a subscriber consumes an event, you earn money. The amount depends on your publisher and subscriber upgrade levels.', graphic: EarnMoneyGraphic },
      { title: 'Upgrade & Expand', body: 'Click the ↑ icon on any component to upgrade it. Buy new components from the sidebar shop to grow your mesh.', graphic: UpgradeExpandGraphic },
    ],
  },
  {
    key: 'brokerUpgrade',
    slides: [
      { title: 'Broker Unlocked!', body: 'Your webhook is now a broker — it routes events instantly with no slowdown. You can now buy queues from the shop to buffer events and prevent drops.', graphic: BrokerUpgradeGraphic },
    ],
  },
  {
    key: 'firstQueue',
    slides: [
      { title: 'Queue Added!', body: 'Queues buffer events so subscribers never miss them. Connect it between a broker and a subscriber using the output ports. Upgrade buffer size and release speed for higher throughput.', graphic: QueueGraphic },
    ],
  },
  {
    key: 'firstDmq',
    slides: [
      { title: 'Dead Message Queue!', body: 'The DMQ catches dropped events as they fall. Connect its top port to a broker to retry them. Upgrade its width to catch more and value recovery to recoup more money.', graphic: DmqGraphic },
    ],
  },
  {
    key: 'firstDrop',
    slides: [
      { title: 'Event Dropped!', body: 'An event was lost because the component it reached was too busy to handle it. Upgrade that component\'s speed or capacity to prevent future drops — or add queues to buffer events when things get backed up.', graphic: EventDropGraphic },
    ],
  },
  {
    key: 'firstPublisher',
    slides: [
      { title: 'New Publisher!', body: 'More publishers means more events flowing through your mesh. Each publisher has its own topic — connect it to a broker to start publishing.', graphic: MultiPublisherGraphic },
    ],
  },
  {
    key: 'firstSubscriber',
    slides: [
      { title: 'New Subscriber!', body: 'Additional subscribers can consume events in parallel. Connect them to queues to increase your throughput and earnings.', graphic: MultiSubscriberGraphic },
    ],
  },
  {
    key: 'firstBroker',
    slides: [
      { title: 'Additional Broker!', body: 'Bridge brokers together to create a full event mesh. Use the bridge slot upgrade to connect brokers and route events across multiple paths.', graphic: MultiBrokerGraphic },
    ],
  },
];

export const tutorialMap: Record<string, TutorialDef> = Object.fromEntries(
  tutorials.map(t => [t.key, t])
);
