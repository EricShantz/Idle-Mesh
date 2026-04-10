import type { ComponentType, ReactNode } from 'react';
import {
  PublisherGraphic,
  WebhookFlowGraphic,
  EarnMoneyGraphic,
  UpgradeExpandGraphic,
  BrokerUpgradeGraphic,
  QueueGraphic,
  DmqGraphic,
  MultiPublisherGraphic,
  MultiSubscriberGraphic,
  MultiBrokerGraphic,
  EventDropGraphic,
  NewComponentsGraphic,
  FanOutGraphic,
  PrestigeTreeGraphic,
  ConnectionManageGraphic,
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
      { title: 'Welcome to Idle Mesh!', body: 'Click the "Publisher" to generate "events".', graphic: PublisherGraphic },
      { title: 'Events Flow Through the Mesh', body: 'Events travel from publishers --> subscribers.', graphic: WebhookFlowGraphic },
      { title: 'Earn Money', body: 'When a subscriber consumes an event, you earn money. Earn more more by upgrading your mesh.', graphic: EarnMoneyGraphic },
      { title: 'Upgrade & Expand', body: 'Click the ⌃ tab above any component to upgrade it. Buy new components from the sidebar shop to grow your mesh.', graphic: UpgradeExpandGraphic },
      { title: 'Managing Connections', body: (<><strong>Click any connection line</strong> to detach it, then drag to a new target — or release on empty space to delete it.</>), graphic: ConnectionManageGraphic },
    ],
  },
  {
    key: 'brokerUpgrade',
    slides: [
      { title: 'Broker Unlocked!', body: 'Your webhook is now a broker! A broker routes events instantly, but has a throughput limit. You can increase that limit by upgrading the component.', graphic: BrokerUpgradeGraphic },
      { title: 'New Components Available!', body: 'Your broker has unlocked new mesh components in the shop. Purchase one to learn what it does and start expanding your event mesh!', graphic: NewComponentsGraphic },
    ],
  },
  {
    key: 'firstQueue',
    slides: [
      { title: 'Queue Added!', body: 'Queues hold events so subscribers never miss them. Connect it between a broker and a subscriber using the output ports. Upgrade queue size and release speed for higher throughput.', graphic: QueueGraphic },
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
      { title: 'Event Dropped!', body: 'An event was lost because the component it reached was too busy to handle it. Upgrade that component\'s speed or capacity to prevent future drops — or add queues to hold events when things get backed up.', graphic: EventDropGraphic },
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
    key: 'firstFanOut',
    slides: [
      { title: 'Persistent Delivery!', body: 'This queue now sends every event to ALL connected subscribers (instead of just one). Add more subscribers to multiply your earnings!', graphic: FanOutGraphic },
    ],
  },
  {
    key: 'firstBroker',
    slides: [
      { title: 'Additional Broker!', body: 'Bridge brokers together to create a full event mesh. Use the bridge slot upgrade to connect brokers and route events across multiple paths.', graphic: MultiBrokerGraphic },
    ],
  },
  {
    key: 'prestigeAvailable',
    slides: [
      { title: 'Schema Registry Available!', body: 'You\'ve earned enough to register your first schema! Open the Schema Registry in the sidebar to reset your progress in exchange for permanent upgrades that carry over between runs.', graphic: PrestigeTreeGraphic },
    ],
  },
];

export const tutorialMap: Record<string, TutorialDef> = Object.fromEntries(
  tutorials.map(t => [t.key, t])
);
