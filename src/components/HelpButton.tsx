import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useGameStore } from '../store/gameStore';
import { tutorials } from '../store/tutorialConfig';
import { getActiveDrops, type DropReason } from '../hooks/useGameLoop';
import type { ComponentType, ReactNode } from 'react';
import {
  PublisherGraphic,
  BrokerUpgradeGraphic,
  QueueGraphic,
  DmqGraphic,
  MultiSubscriberGraphic,
  WebhookFlowGraphic,
} from './TutorialGraphics';

type ComponentDetail = {
  key: string;
  label: string;
  unlockCheck: string;
  color: string;
  graphic: ComponentType;
  overview: string;
  howItWorks: string[];
  upgrades: { name: string; effect: string }[];
  tips: string[];
};

const componentDetails: ComponentDetail[] = [
  {
    key: 'publisher',
    label: 'Publisher',
    unlockCheck: 'intro',
    color: '#22d3ee',
    graphic: PublisherGraphic,
    overview: 'Publishers generate events — the core resource of your mesh. Click one to fire an event, or unlock auto-click to automate it.',
    howItWorks: [
      'Click to fire an event along connected paths',
      'Each publisher has a unique topic (e.g. "orders/created")',
      'Events carry a base value determined by the Event Value upgrade',
      'Cooldown timer prevents spam — upgrade Publish Speed to reduce it',
      'Connect output port to a webhook or broker to route events',
    ],
    upgrades: [
      { name: 'Event Value', effect: 'Increases the base dollar value each event carries' },
      { name: 'Publish Speed', effect: 'Reduces cooldown between clicks (max 10 levels)' },
      { name: 'Auto-Click', effect: 'Automatically fires events at the current publish speed' },
    ],
    tips: [
      'Auto-click is a huge throughput boost — prioritize it for your first publisher',
      'Higher event value multiplies through the entire chain, so it scales well late-game',
    ],
  },
  {
    key: 'webhook',
    label: 'Webhook',
    unlockCheck: 'intro',
    color: '#a78bfa',
    graphic: WebhookFlowGraphic,
    overview: 'The webhook is your starting relay — it passes events from publishers to subscribers, but adds a delay.',
    howItWorks: [
      'Events slow down as they pass through the webhook',
      'Only one event can occupy the webhook at a time',
      'If a second event arrives while one is passing through, it gets dropped',
      'Upgrade to a Broker to remove the delay.',
    ],
    upgrades: [
      { name: 'Upgrade to Broker', effect: 'Converts the webhook into an instant-relay broker and unlocks additional components in the shop' },
    ],
    tips: [
      'The webhook is your biggest bottleneck early on — upgrade to a broker as soon as you can afford it',
    ],
  },
  {
    key: 'broker',
    label: 'Broker',
    unlockCheck: 'brokerUpgrade',
    color: '#a78bfa',
    graphic: BrokerUpgradeGraphic,
    overview: 'Brokers are the backbone of your mesh. They route events instantly to queues using topic matching, and can bridge to other brokers.',
    howItWorks: [
      'Events pass through instantly (no delay like webhooks)',
      'Routes events to connected queues based on topic matching',
      'Fans out to ALL matching queues — every connected queue with a matching topic gets a copy',
      'Has a throughput limit (events/sec) — excess events are dropped',
      'Can bridge to other brokers to create a wider event mesh',
    ],
    upgrades: [
      { name: 'Add Queue Slot', effect: 'Allows connecting one more queue to this broker' },
      { name: 'Add Bridge Slot', effect: 'Allows connecting to another broker for mesh bridging' },
      { name: 'Increase Throughput', effect: 'Raises the max events/sec the broker can relay (max 10 levels)' },
    ],
    tips: [
      'Throughput upgrades are critical once you have multiple auto-publishers feeding in',
      'Bridge two brokers together to share load and reach more queues',
      'Connect multiple queues with matching topics to multiply your event throughput',
    ],
  },
  {
    key: 'queue',
    label: 'Queue',
    unlockCheck: 'firstQueue',
    color: '#facc15',
    graphic: QueueGraphic,
    overview: 'Queues hold events so nothing gets dropped while subscribers are busy. They\'re essential for reliable, high-throughput setups.',
    howItWorks: [
      'Events enter the queue and wait until a subscriber is free',
      'Connected subscribers pull events one at a time from the queue',
      'If the queue is full, new events are dropped',
      'Topic filter determines which events the queue accepts from the broker',
      'Fan-out mode sends every event to ALL connected subscribers instead of just one',
    ],
    upgrades: [
      { name: 'Add Subscriber Slot', effect: 'Connect one more subscriber to this queue' },
      { name: 'Persistent Delivery (Fan-out)', effect: 'All connected subscribers receive every event (multiplies earnings)' },
      { name: 'Increase Queue Size', effect: 'Adds more queue slots before events drop (max 20 slots)' },
      { name: 'Broaden Subscription', effect: 'Widens the topic filter to accept events from more publishers (max 5 levels)' },
    ],
    tips: [
      'Fan-out is extremely powerful — each extra subscriber multiplies your income from that queue',
      'Broaden subscription early so your queue accepts events from multiple publishers',
      'Queue size prevents drops during traffic spikes — upgrade it if you see events falling',
    ],
  },
  {
    key: 'subscriber',
    label: 'Subscriber',
    unlockCheck: 'intro',
    color: '#4ade80',
    graphic: MultiSubscriberGraphic,
    overview: 'Subscribers consume events and turn them into money — the final step in your event pipeline.',
    howItWorks: [
      'Pulls events from its connected queue (or directly from a webhook/broker)',
      'Each event takes time to consume — the subscriber is busy during this period',
      'Money is earned when consumption completes',
      'Payout = event base value x all upstream multipliers x consumption multiplier',
      'If an event arrives while the subscriber is busy (and there\'s no queue), it drops',
    ],
    upgrades: [
      { name: 'Consumption Multiplier', effect: '+50% payout multiplier per level — scales with all upstream value' },
      { name: 'Faster Consumption', effect: 'Speeds up event processing so the subscriber is free sooner (max 11 levels)' },
    ],
    tips: [
      'Faster consumption means less time busy, which means fewer drops and more throughput',
      'Consumption multiplier stacks multiplicatively with event value — both are worth upgrading',
      'Always connect subscribers to queues rather than directly to brokers for reliable delivery',
    ],
  },
  {
    key: 'dmq',
    label: 'Dead Message Queue',
    unlockCheck: 'firstDmq',
    color: '#f87171',
    graphic: DmqGraphic,
    overview: 'The DMQ is your safety net — it catches events that fall off the mesh and lets you recover their value.',
    howItWorks: [
      'Sits at the bottom of the screen and catches falling (dropped) events',
      'Caught events can be retried by connecting the DMQ\'s top port to a broker',
      'Retried events recover a percentage of their original value (based on Value Recovery level)',
      'Has a queue — if full, additional caught events overflow and are lost',
      'Width determines the physical catch zone',
    ],
    upgrades: [
      { name: 'Increase Width', effect: 'Widens the catch zone by 40px per level' },
      { name: 'Increase Queue Size', effect: 'Holds more caught events before overflow' },
      { name: 'Value Recovery', effect: '+10% recovered value per level when retrying events (max 9 levels, up to 100%)' },
    ],
    tips: [
      'Position your DMQ under the busiest part of your mesh where drops happen most',
      'Max out value recovery to get full value from retried events',
      'Connect to a broker to actually retry events — without a connection, caught events just sit there',
    ],
  },
];

const tutorialLabels: Record<string, string> = {
  intro: 'Getting Started',
  brokerUpgrade: 'Broker Unlocked',
  firstQueue: 'First Queue',
  firstDmq: 'Dead Message Queue',
  firstDrop: 'Event Dropped',
  firstPublisher: 'New Publisher',
  firstSubscriber: 'New Subscriber',
  firstFanOut: 'Persistent Delivery',
  firstBroker: 'Additional Broker',
};

const dropReasonMessages: Record<DropReason, { label: string; fix: string }> = {
  'webhook-occupied': { label: 'Webhook is busy', fix: 'Upgrade to Broker to remove the bottleneck' },
  'broker-capped': { label: 'Throughput limit reached', fix: 'Upgrade "Increase Throughput" on this broker' },
  'queue-full': { label: 'Queue buffer is full', fix: 'Upgrade "Queue Size" or add more subscribers' },
  'subscriber-occupied': { label: 'Subscriber is busy', fix: 'Upgrade "Faster Consumption" or add more subscribers' },
  'path-incomplete': { label: 'No matching destination', fix: 'Connect the broker to a queue with a matching topic subscription' },
  'path-invalid': { label: 'Connection broken', fix: 'Reconnect the missing path' },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">{title}</h4>
      {children}
    </div>
  );
}

export function HelpButton() {
  const [open, setOpen] = useState(false);
  const [viewingComponent, setViewingComponent] = useState<string | null>(null);
  const [warningOpen, setWarningOpen] = useState(false);
  const [activeDrops, setActiveDrops] = useState<Array<{ nodeId: string; nodeLabel: string; reason: DropReason }>>([]);
  const tutorialsSeen = useGameStore(s => s.tutorialsSeen);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveDrops(getActiveDrops());
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const seenTutorials = tutorials.filter(t => tutorialsSeen[t.key]);
  const unlockedComponents = componentDetails.filter(c => tutorialsSeen[c.unlockCheck]);
  const activeComponent = componentDetails.find(c => c.key === viewingComponent);

  const handleReplayTutorial = (key: string) => {
    setOpen(false);
    setViewingComponent(null);
    useGameStore.setState({ activeTutorial: key });
  };

  const closeAll = () => { setOpen(false); setViewingComponent(null); setWarningOpen(false); };

  return (
    <>
      <button
        onClick={() => { setOpen(o => !o); if (open) setViewingComponent(null); }}
        className="fixed top-3 left-3 w-9 h-9 rounded-full border border-gray-600 bg-gray-800/90 hover:bg-gray-700 text-gray-300 hover:text-white flex items-center justify-center text-lg font-bold backdrop-blur-sm transition-colors"
        style={{ zIndex: 50 }}
        title="Help & Info"
      >
        ?
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed top-14 left-3 flex items-start gap-0"
            style={{ zIndex: 50 }}
          >
            {/* Left menu */}
            <div className="w-56 rounded-lg border border-gray-700 bg-gray-900/95 backdrop-blur-sm shadow-xl overflow-hidden shrink-0">
              {seenTutorials.length > 0 && (
                <div className="p-3 pb-2">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Tutorials</h3>
                  <div className="flex flex-col gap-0.5">
                    {seenTutorials.map(t => (
                      <button
                        key={t.key}
                        onClick={() => handleReplayTutorial(t.key)}
                        className="text-left text-sm text-gray-300 hover:text-cyan-400 hover:bg-gray-800 rounded px-2 py-1 transition-colors"
                      >
                        {tutorialLabels[t.key] || t.slides[0]?.title || t.key}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {unlockedComponents.length > 0 && (
                <div className="p-3 pt-1 border-t border-gray-700/50">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Components</h3>
                  <div className="flex flex-col gap-0.5">
                    {unlockedComponents.map(c => (
                      <button
                        key={c.key}
                        onClick={() => setViewingComponent(viewingComponent === c.key ? null : c.key)}
                        className={`text-left text-sm rounded px-2 py-1 transition-colors ${viewingComponent === c.key
                          ? 'text-cyan-400 bg-gray-800'
                          : 'text-gray-300 hover:text-cyan-400 hover:bg-gray-800'
                          }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Right detail panel */}
            <AnimatePresence>
              {activeComponent && (
                <motion.div
                  key={activeComponent.key}
                  initial={{ opacity: 0, x: -12, width: 0 }}
                  animate={{ opacity: 1, x: 0, width: 680 }}
                  exit={{ opacity: 0, x: -12, width: 0 }}
                  transition={{ duration: 0.18 }}
                  className="rounded-lg border border-gray-700 bg-gray-900/95 backdrop-blur-sm shadow-xl overflow-hidden ml-2"
                >
                  <div className="p-5 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 80px)', width: 680 }}>
                    {/* Header */}
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-3 h-3 rounded-full" style={{ background: activeComponent.color }} />
                      <h3 className="text-base font-bold text-white">{activeComponent.label}</h3>
                    </div>

                    {/* Graphic */}
                    <div className="mb-4 rounded-lg overflow-hidden flex items-center justify-center">
                      <activeComponent.graphic />
                    </div>

                    <p className="text-sm text-gray-300 leading-relaxed mb-4">{activeComponent.overview}</p>

                    <Section title="How it works">
                      <ul className="space-y-1">
                        {activeComponent.howItWorks.map((item, i) => (
                          <li key={i} className="text-sm text-gray-300 leading-relaxed flex gap-2">
                            <span className="text-gray-500 shrink-0">-</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </Section>

                    <Section title="Upgrades">
                      <div className="space-y-2">
                        {activeComponent.upgrades.map((u, i) => (
                          <div key={i} className="bg-gray-800/60 rounded px-2.5 py-1.5">
                            <span className="text-sm font-medium text-cyan-400">{u.name}</span>
                            <p className="text-xs text-gray-400 mt-0.5">{u.effect}</p>
                          </div>
                        ))}
                      </div>
                    </Section>

                    <Section title="Tips">
                      <ul className="space-y-1">
                        {activeComponent.tips.map((tip, i) => (
                          <li key={i} className="text-sm text-gray-400 leading-relaxed flex gap-2">
                            <span className="text-cyan-600 shrink-0">*</span>
                            {tip}
                          </li>
                        ))}
                      </ul>
                    </Section>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Click outside to close */}
      {(open || warningOpen) && (
        <div
          className="fixed inset-0"
          style={{ zIndex: 49 }}
          onClick={closeAll}
        />
      )}

      {/* Warning "!" button */}
      {activeDrops.length > 0 && (
        <button
          onClick={() => { setWarningOpen(o => !o); if (!warningOpen) { setOpen(false); setViewingComponent(null); } }}
          className="fixed top-3 left-14 w-9 h-9 rounded-full border border-amber-500 bg-amber-900/50 hover:bg-amber-800/60 text-amber-400 hover:text-amber-300 flex items-center justify-center text-lg font-bold backdrop-blur-sm transition-colors animate-pulse"
          style={{ zIndex: 50 }}
          title="Events are dropping!"
        >
          !
        </button>
      )}

      <AnimatePresence>
        {warningOpen && activeDrops.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="fixed top-14 left-14 w-72 rounded-lg border border-gray-700 bg-gray-900/95 backdrop-blur-sm shadow-xl overflow-hidden"
            style={{ zIndex: 50 }}
          >
            <div className="p-3">
              <h3 className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-2">Events Dropping</h3>
              <div className="flex flex-col gap-2">
                {activeDrops.map(drop => {
                  const msg = dropReasonMessages[drop.reason];
                  return (
                    <div
                      key={drop.nodeId}
                      className="rounded px-2.5 py-1.5 bg-gray-800/60 border-l-2 border-amber-500"
                    >
                      <div className="text-sm font-medium text-gray-200">{drop.nodeLabel}</div>
                      <div className="text-xs text-amber-300 mt-0.5">{msg.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{msg.fix}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
