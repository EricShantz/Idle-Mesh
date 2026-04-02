export type TutorialSlide = {
  title: string;
  body: string;
};

export type TutorialDef = {
  key: string;
  slides: TutorialSlide[];
};

export const tutorials: TutorialDef[] = [
  {
    key: 'intro',
    slides: [
      { title: 'Welcome to Idle Mesh!', body: 'Build and scale a distributed event mesh. Click the "Publisher" to send events into the system.' },
      { title: 'Events Flow Through the Mesh', body: 'Events travel publishers to subscribers. Watch them move along the connection lines.' },
      { title: 'Earn Money', body: 'When a subscriber consumes an event, you earn money. The amount depends on your publisher and subscriber upgrade levels.' },
      { title: 'Upgrade & Expand', body: 'Click the ↑ icon on any component to upgrade it. Buy new components from the sidebar shop to grow your mesh.' },
    ],
  },
  {
    key: 'brokerUpgrade',
    slides: [
      { title: 'Broker Unlocked!', body: 'Your webhook is now a broker — it routes events instantly with no slowdown. You can now buy queues from the shop to buffer events and prevent drops.' },
    ],
  },
  {
    key: 'firstQueue',
    slides: [
      { title: 'Queue Added!', body: 'Queues buffer events so subscribers never miss them. Connect it between a broker and a subscriber using the output ports. Upgrade buffer size and release speed for higher throughput.' },
    ],
  },
  {
    key: 'firstDmq',
    slides: [
      { title: 'Dead Message Queue!', body: 'The DMQ catches dropped events as they fall. Connect its top port to a broker to retry them. Upgrade its width to catch more and value recovery to recoup more money.' },
    ],
  },
  {
    key: 'firstPublisher',
    slides: [
      { title: 'New Publisher!', body: 'More publishers means more events flowing through your mesh. Each publisher has its own topic — connect it to a broker to start publishing.' },
    ],
  },
  {
    key: 'firstSubscriber',
    slides: [
      { title: 'New Subscriber!', body: 'Additional subscribers can consume events in parallel. Connect them to queues to increase your throughput and earnings.' },
    ],
  },
  {
    key: 'firstBroker',
    slides: [
      { title: 'Additional Broker!', body: 'Bridge brokers together to create a full event mesh. Use the bridge slot upgrade to connect brokers and route events across multiple paths.' },
    ],
  },
];

export const tutorialMap: Record<string, TutorialDef> = Object.fromEntries(
  tutorials.map(t => [t.key, t])
);
