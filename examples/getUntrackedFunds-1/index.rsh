'reach 0.1';

export const main = Reach.App(() => {
  const A = Participant('Alice', {});
  const B = Participant('Bob', {
    gimmeSomeDough: Fun([Address], Null),
  });
  deploy();

  A.publish();
  const x1 = getUntrackedFunds();

  transfer(x1).to(A);
  commit();

  B.only(() => {
    interact.gimmeSomeDough(getAddress());
  });
  B.publish();

  const x = getUntrackedFunds();

  transfer(x).to(A);
  commit();

  exit();
});
