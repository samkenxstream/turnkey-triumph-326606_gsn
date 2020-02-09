const { balance, BN, constants, ether, expectEvent, expectRevert, send, time } = require('@openzeppelin/test-helpers')
const { ZERO_ADDRESS } = constants

const { getEip712Signature, getRelayRequest } = require('../src/js/relayclient/utils')

const RelayHub = artifacts.require('RelayHub')
const SampleRecipient = artifacts.require('./test/TestRecipient')
const TestSponsor = artifacts.require('./test/TestSponsorEverythingAccepted')
const TestSponsorStoreContext = artifacts.require('./test/TestSponsorStoreContext')
const TestSponsorConfigurableMisbehavior = artifacts.require('./test/TestSponsorConfigurableMisbehavior')

const { expect } = require('chai')

contract('RelayHub', function ([_, relayOwner, relay, otherRelay, sender, other, dest]) { // eslint-disable-line no-unused-vars
  const RelayCallStatusCodes = {
    OK: new BN('0'),
    RelayedCallFailed: new BN('1'),
    PreRelayedFailed: new BN('2'),
    PostRelayedFailed: new BN('3'),
    RecipientBalanceChanged: new BN('4')
  }

  const PreconditionCheck = {
    OK: new BN('0'),
    WrongSignature: new BN('1'),
    WrongNonce: new BN('2'),
    AcceptRelayedCallReverted: new BN('3'),
    InvalidRecipientStatusCode: new BN('4')
  }

  let relayHub
  let recipient
  let gasSponsor

  beforeEach(async function () {
    relayHub = await RelayHub.new({ gas: 8000000 })
    recipient = await SampleRecipient.new()
    gasSponsor = await TestSponsor.new()
    await recipient.setHub(relayHub.address)
    await gasSponsor.setHub(relayHub.address)
  })

  describe('relay management', function () {
    describe('staking', function () {
      it('unstaked relays can be staked for by anyone', async function () {
        const { logs } = await relayHub.stake(relay, time.duration.weeks(4), {
          value: ether('1'),
          from: other
        })
        expectEvent.inLogs(logs, 'Staked', {
          relay,
          stake: ether('1'),
          unstakeDelay: time.duration.weeks(4)
        })
      })

      it('relays cannot stake for themselves', async function () {
        await expectRevert(
          relayHub.stake(relay, time.duration.weeks(4), {
            value: ether('1'),
            from: relay
          }),
          'relay cannot stake for itself'
        )
      })

      it('relays cannot be staked for with a stake under the minimum', async function () {
        const minimumStake = ether('1')

        await expectRevert(
          relayHub.stake(relay, time.duration.weeks(4), {
            value: minimumStake.subn(1),
            from: other
          }),
          'stake lower than minimum'
        )
      })

      it('relays cannot be staked for with an unstake delay under the minimum', async function () {
        const minimumUnstakeDelay = time.duration.weeks(1)

        await expectRevert(
          relayHub.stake(relay, minimumUnstakeDelay.subn(1), {
            value: ether('1'),
            from: other
          }),
          'delay lower than minimum'
        )
      })

      it('relays cannot be staked for with an unstake delay over the maximum', async function () {
        const maximumUnstakeDelay = time.duration.weeks(12)

        await expectRevert(
          relayHub.stake(relay, maximumUnstakeDelay.addn(1), {
            value: ether('1'),
            from: other
          }),
          'delay higher than maximum'
        )
      })

      context('with staked relay', function () {
        const initialStake = ether('2')
        const initialUnstakeDelay = time.duration.weeks(4)

        beforeEach(async function () {
          await relayHub.stake(relay, initialUnstakeDelay, {
            value: initialStake,
            from: relayOwner
          })
        })

        it('relay owner can be queried', async function () {
          expect((await relayHub.getRelay(relay)).owner).to.equal(relayOwner)
        })

        it('relay stake can be queried', async function () {
          expect((await relayHub.getRelay(relay)).totalStake).to.be.bignumber.equals(initialStake)
        })

        it('relay unstake delay can be queried', async function () {
          expect((await relayHub.getRelay(relay)).unstakeDelay).to.be.bignumber.equal(initialUnstakeDelay)
        })

        function testStake () {
          it('owner can increase the relay stake', async function () {
            const addedStake = ether('2')
            const { logs } = await relayHub.stake(relay, initialUnstakeDelay, {
              value: addedStake,
              from: relayOwner
            })
            expectEvent.inLogs(logs, 'Staked', {
              relay,
              stake: initialStake.add(addedStake),
              unstakeDelay: initialUnstakeDelay
            })

            expect((await relayHub.getRelay(relay)).totalStake).to.be.bignumber.equals(initialStake.add(addedStake))
          })

          it('owner can increase the unstake delay', async function () {
            const newUnstakeDelay = time.duration.weeks(6)
            const { logs } = await relayHub.stake(relay, newUnstakeDelay, { from: relayOwner })
            expectEvent.inLogs(logs, 'Staked', {
              relay,
              stake: initialStake,
              unstakeDelay: newUnstakeDelay
            })

            expect((await relayHub.getRelay(relay)).unstakeDelay).to.be.bignumber.equals(newUnstakeDelay)
          })
        }

        testStake()

        it('owner cannot decrease the unstake delay', async function () {
          await expectRevert(
            relayHub.stake(relay, initialUnstakeDelay.subn(1), { from: relayOwner }),
            'unstakeDelay cannot be decreased'
          )
        })

        it('non-owner cannot stake or increase the unstake delay', async function () {
          await expectRevert(
            relayHub.stake(relay, initialUnstakeDelay, { from: other }),
            'not owner'
          )
        })

        context('with registered relay', function () {
          beforeEach(async function () {
            await relayHub.registerRelay(10, 'http://test.url.com', { from: relay })
          })

          testStake()

          context('with unregistered relay', function () {
            beforeEach(async function () {
              await relayHub.removeRelayByOwner(relay, { from: relayOwner })
            })

            it('relay cannot be staked for', async function () {
              await expectRevert(
                relayHub.stake(relay, initialUnstakeDelay, { from: relayOwner }),
                'wrong state for stake'
              )
            })

            context('with unstaked relay', function () {
              beforeEach(async function () {
                await time.increase(initialUnstakeDelay)
                await relayHub.unstake(relay, { from: relayOwner })
              })

              it('relay can be restaked for with another owner', async function () {
                await relayHub.stake(relay, initialUnstakeDelay, {
                  value: initialStake,
                  from: other
                })
                expect((await relayHub.getRelay(relay)).owner).to.equal(other)
              })
            })
          })
        })
      })
    })

    describe('registering', function () {
      const transactionFee = new BN('10')
      const url = 'http://relay.com'

      it('unstaked relays cannot be registered', async function () {
        await expectRevert(relayHub.registerRelay(transactionFee, url, { from: relay }), 'wrong state for stake')
      })

      context('with staked relay', function () {
        const stake = ether('2')
        const unstakeDelay = time.duration.weeks(4)

        beforeEach(async function () {
          await relayHub.stake(relay, unstakeDelay, {
            value: stake,
            from: relayOwner
          })
        })

        // This test caauses the relay account to have no more balance and all other tests to fail
        it.skip('a relay must have more than the minimum balance to be registered', async function () {
          const relayBalance = await balance.current(relay)

          // Minimum balance is 0.1 ether
          await send.ether(relay, ZERO_ADDRESS, relayBalance - ether('0.09'))

          await expectRevert(relayHub.registerRelay(transactionFee, url, {
            from: relay,
            gasPrice: 0
          }), 'balance lower than minimum')
        })

        it('relay can register itself', async function () {
          const { logs } = await relayHub.registerRelay(transactionFee, url, { from: relay })
          expectEvent.inLogs(logs, 'RelayAdded', {
            relay,
            owner: relayOwner,
            transactionFee,
            stake,
            unstakeDelay,
            url
          })
        })

        context('with registered relay', function () {
          beforeEach(async function () {
            await relayHub.registerRelay(transactionFee, url, { from: relay })
          })

          it('relays can re-register with different transaction fee and url', async function () {
            const newTransactionFee = new BN('20')
            const newUrl = 'http://new-relay.com'

            const { logs } = await relayHub.registerRelay(newTransactionFee, newUrl, { from: relay })
            expectEvent.inLogs(logs, 'RelayAdded', {
              relay,
              owner: relayOwner,
              transactionFee: newTransactionFee,
              stake,
              unstakeDelay,
              url: newUrl
            })
          })

          context('with removed relay', function () {
            beforeEach(async function () {
              await relayHub.removeRelayByOwner(relay, { from: relayOwner })
            })

            it('relay cannot re-register', async function () {
              await expectRevert(relayHub.registerRelay(transactionFee, url, { from: relay }), 'wrong state for stake')
            })
          })
        })
      })
    })

    describe('unregistering', function () {
      context('with staked relay', function () {
        const stake = ether('2')
        const unstakeDelay = time.duration.weeks(4)

        beforeEach(async function () {
          await relayHub.stake(relay, unstakeDelay, {
            value: stake,
            from: relayOwner
          })
        })

        it('an unregistered relay can be removed', async function () {
          const { logs } = await relayHub.removeRelayByOwner(relay, { from: relayOwner })
          expectEvent.inLogs(logs, 'RelayRemoved', {
            relay,
            unstakeTime: (await time.latest()).add(unstakeDelay)
          })
        })

        it('a registered relay can be removed', async function () {
          await relayHub.registerRelay(10, 'http://test.url.com', { from: relay })

          const { logs } = await relayHub.removeRelayByOwner(relay, { from: relayOwner })
          expectEvent.inLogs(logs, 'RelayRemoved', {
            relay,
            unstakeTime: (await time.latest()).add(unstakeDelay)
          })
        })

        it('non-owners cannot remove a relay', async function () {
          await expectRevert(relayHub.removeRelayByOwner(relay, { from: other }), 'not owner')
        })

        context('with removed relay', function () {
          beforeEach(async function () {
            await relayHub.removeRelayByOwner(relay, { from: relayOwner })
          })

          it('relay cannot be re-removed', async function () {
            await expectRevert(relayHub.removeRelayByOwner(relay, { from: relayOwner }), 'already removed')
          })
        })
      })
    })

    describe('unstaking', function () {
      before(async function () {
        await time.increase(time.duration.weeks(4))
        await relayHub.unstake(relay, { from: relayOwner })
      })

      it('unstaked relays cannot be unstaked', async function () {
        await expectRevert(relayHub.unstake(relay, { from: other }), 'Relay is not pending unstake')
      })

      context('with staked relay', function () {
        const stake = ether('2')
        const unstakeDelay = time.duration.weeks(4)

        beforeEach(async function () {
          await relayHub.stake(relay, unstakeDelay, {
            value: stake,
            from: relayOwner
          })
        })

        it('unregistered relays cannnot be unstaked', async function () {
          await expectRevert(relayHub.unstake(relay, { from: relayOwner }), 'Relay is not pending unstake')
        })

        context('with registerd relay', function () {
          beforeEach(async function () {
            await relayHub.registerRelay(10, 'http://test.url.com', { from: relay })
          })

          it('unremoved relays cannot be unstaked', async function () {
            await expectRevert(relayHub.unstake(relay, { from: relayOwner }), 'Relay is not pending unstake')
          })

          context('with removed relay', function () {
            beforeEach(async function () {
              await relayHub.removeRelayByOwner(relay, { from: relayOwner })
            })

            it('relay cannot be unstaked before unstakeTime', async function () {
              await expectRevert(relayHub.unstake(relay, { from: relayOwner }), 'Unstake is not due')
            })

            context('after unstakeTime', function () {
              beforeEach(async function () {
                await time.increase(unstakeDelay)
                expect(await time.latest()).to.be.bignumber.at.least((await relayHub.getRelay(relay)).unstakeTime)
              })

              it('owner can unstake relay', async function () {
                const relayOwnerBalanceTracker = await balance.tracker(relayOwner)
                const relayHubBalanceTracker = await balance.tracker(relayHub.address)

                // We call unstake with a gasPrice of zero to accurately measure the balance change in the relayOwner
                const { logs } = await relayHub.unstake(relay, {
                  from: relayOwner,
                  gasPrice: 0
                })
                expectEvent.inLogs(logs, 'Unstaked', {
                  relay,
                  stake
                })

                expect(await relayOwnerBalanceTracker.delta()).to.be.bignumber.equals(stake)
                expect(await relayHubBalanceTracker.delta()).to.be.bignumber.equals(stake.neg())
              })

              it('non-owner cannot unstake relay', async function () {
                await expectRevert(relayHub.unstake(relay, { from: other }), 'not owner')
              })

              context('with unstaked relay', function () {
                beforeEach(async function () {
                  await relayHub.unstake(relay, { from: relayOwner })
                })

                it('relay cannot be re-unstaked', async function () {
                  await expectRevert(relayHub.unstake(relay, { from: relayOwner }), 'Relay is not pending unstake')
                })
              })
            })
          })
        })
      })
    })
  })

  describe('balances', function () {
    async function testDeposit (sender, sponsor, amount) {
      const senderBalanceTracker = await balance.tracker(sender)
      const relayHubBalanceTracker = await balance.tracker(relayHub.address)

      const { logs } = await relayHub.depositFor(sponsor, { from: sender, value: amount, gasPrice: 0 })
      expectEvent.inLogs(logs, 'Deposited', { sponsor, from: sender, amount })

      expect(await relayHub.balanceOf(sponsor)).to.be.bignumber.equals(amount)
      expect(await senderBalanceTracker.delta()).to.be.bignumber.equals(amount.neg())
      expect(await relayHubBalanceTracker.delta()).to.be.bignumber.equals(amount)
    }

    it('can deposit for self', async function () {
      await testDeposit(other, other, ether('1'))
    })

    it('can deposit for others', async function () {
      await testDeposit(other, recipient.address, ether('1'))
    })

    it('cannot deposit amounts larger than the limit', async function () {
      await expectRevert(
        relayHub.depositFor(recipient.address, { from: other, value: ether('3'), gasPrice: 0 }),
        'deposit too big'
      )
    })

    it('can deposit multiple times and have a total deposit larger than the limit', async function () {
      await relayHub.depositFor(recipient.address, { from: other, value: ether('1'), gasPrice: 0 })
      await relayHub.depositFor(recipient.address, { from: other, value: ether('1'), gasPrice: 0 })
      await relayHub.depositFor(recipient.address, { from: other, value: ether('1'), gasPrice: 0 })

      expect(await relayHub.balanceOf(recipient.address)).to.be.bignumber.equals(ether('3'))
    })

    it('accounts with deposits can withdraw partially', async function () {
      const amount = ether('1')
      await testDeposit(other, other, amount)

      const { logs } = await relayHub.withdraw(amount.divn(2), dest, { from: other })
      expectEvent.inLogs(logs, 'Withdrawn', { account: other, dest, amount: amount.divn(2) })
    })

    it('accounts with deposits can withdraw all their balance', async function () {
      const amount = ether('1')
      await testDeposit(other, other, amount)

      const { logs } = await relayHub.withdraw(amount, dest, { from: other })
      expectEvent.inLogs(logs, 'Withdrawn', { account: other, dest, amount })
    })

    it('accounts cannot withdraw more than their balance', async function () {
      const amount = ether('1')
      await testDeposit(other, other, amount)

      await expectRevert(relayHub.withdraw(amount.addn(1), dest, { from: other }), 'insufficient funds')
    })
  })

  describe('canRelay & relayCall', function () {
    context('with staked and registered relay', function () {
      const unstakeDelay = time.duration.weeks(4)

      const url = 'http://relay.com'
      const fee = new BN('10') // 10%

      beforeEach(async function () {
        await relayHub.stake(relay, unstakeDelay, { value: ether('2'), from: relayOwner })

        await relayHub.registerRelay(fee, url, { from: relay })
      })

      const message = 'GSN RelayHub'

      const gasPrice = new BN('10')
      const gasLimit = new BN('1000000')
      const senderNonce = new BN('0')

      let txData

      // TODO: this is a piece of legacy structure of this test suite. The signature could afford to be static
      //  throughout the test as there were no moving parts signed. Using multiple sponsors breaks it. Fix later.
      let sharedSigValues
      beforeEach(async function () {
        // truffle-contract doesn't let us create method data from the class, we need an actual instance
        txData = recipient.contract.methods.emitMessage(message).encodeABI()
        sharedSigValues = {
          web3,
          senderAccount: sender,
          senderNonce: senderNonce.toString(),
          target: recipient.address,
          encodedFunction: txData,
          pctRelayFee: fee.toString(),
          gasPrice: gasPrice.toString(),
          gasLimit: gasLimit.toString(),
          relayHub: relayHub.address,
          relayAddress: relay
        }
      })

      context('with funded recipient', function () {
        let gasSponsorWithContext
        let misbehavingSponsor
        let signatureWithContextSponsor
        let signatureWithMisbehavingSponsor
        beforeEach(async function () {
          gasSponsorWithContext = await TestSponsorStoreContext.new()
          misbehavingSponsor = await TestSponsorConfigurableMisbehavior.new()
          await gasSponsorWithContext.setHub(relayHub.address)
          await misbehavingSponsor.setHub(relayHub.address)
          await relayHub.depositFor(gasSponsorWithContext.address, { value: ether('1'), from: other })
          await relayHub.depositFor(misbehavingSponsor.address, { value: ether('1'), from: other })

          signatureWithMisbehavingSponsor = (await getEip712Signature({
            ...sharedSigValues,
            gasSponsor: misbehavingSponsor.address
          })).signature

          signatureWithContextSponsor = (await getEip712Signature({
            ...sharedSigValues,
            gasSponsor: gasSponsorWithContext.address
          })).signature
        })

        it('preRelayedCall receives values returned in acceptRelayedCall', async function () {
          const relayRequest = getRelayRequest(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, relay, gasSponsorWithContext.address)
          const { tx } = await relayHub.relayCall(relayRequest, signatureWithContextSponsor, '0x', {
            from: relay,
            gasPrice,
            gasLimit
          })

          const maxPossibleCharge = await relayHub.maxPossibleCharge(gasLimit, gasPrice, fee)

          await expectEvent.inTransaction(tx, TestSponsorStoreContext, 'SampleRecipientPreCallWithValues', {
            relay,
            from: sender,
            encodedFunction: txData,
            transactionFee: fee,
            gasPrice,
            gasLimit,
            nonce: senderNonce,
            approvalData: null,
            maxPossibleCharge
          })
        })

        it('postRelayedCall receives values returned in acceptRelayedCall', async function () {
          const relayRequest = getRelayRequest(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, relay, gasSponsorWithContext.address)
          const { tx } = await relayHub.relayCall(relayRequest, signatureWithContextSponsor, '0x', {
            from: relay,
            gasPrice,
            gasLimit
          })

          const maxPossibleCharge = await relayHub.maxPossibleCharge(gasLimit, gasPrice, fee)

          await expectEvent.inTransaction(tx, TestSponsorStoreContext, 'SampleRecipientPostCallWithValues', {
            relay,
            from: sender,
            encodedFunction: txData,
            transactionFee: fee,
            gasPrice,
            gasLimit,
            nonce: senderNonce,
            approvalData: null,
            maxPossibleCharge
          })
        })

        it('relaying is aborted if the recipient returns an invalid status code', async function () {
          await misbehavingSponsor.setReturnInvalidErrorCode(true)
          const relayRequest = getRelayRequest(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, relay, misbehavingSponsor.address)
          const { logs } = await relayHub.relayCall(relayRequest, signatureWithMisbehavingSponsor, '0x', {
            from: relay,
            gasPrice,
            gasLimit
          })

          expectEvent.inLogs(logs, 'CanRelayFailed', { reason: PreconditionCheck.InvalidRecipientStatusCode })
        })

        describe('recipient balance withdrawal ban', function () {
          let signature
          let misbehavingSponsor
          beforeEach(async function () {
            misbehavingSponsor = await TestSponsorConfigurableMisbehavior.new()
            await misbehavingSponsor.setHub(relayHub.address)
            await relayHub.depositFor(misbehavingSponsor.address, { value: ether('1'), from: other })
            const eip712Sig = await getEip712Signature({
              ...sharedSigValues,
              gasSponsor: misbehavingSponsor.address
            })
            signature = eip712Sig.signature
          })

          it('reverts relayed call if recipient withdraws balance during preRelayedCall', async function () {
            await misbehavingSponsor.setWithdrawDuringPreRelayedCall(true)
            await assertRevertWithRecipientBalanceChanged()
          })

          it('reverts relayed call if recipient withdraws balance during the relayed call', async function () {
            await recipient.setWithdrawDuringRelayedCall(misbehavingSponsor.address)
            await assertRevertWithRecipientBalanceChanged()
          })

          it('reverts relayed call if recipient withdraws balance during postRelayedCall', async function () {
            await misbehavingSponsor.setWithdrawDuringPostRelayedCall(true)
            await assertRevertWithRecipientBalanceChanged()
          })

          async function assertRevertWithRecipientBalanceChanged () {
            const relayRequest = getRelayRequest(
              sender, recipient.address, txData,
              fee, gasPrice, gasLimit, senderNonce,
              relay, misbehavingSponsor.address
            )
            const { logs } = await relayHub.relayCall(relayRequest, signature, '0x', {
              from: relay,
              gasPrice,
              gasLimit
            })
            expectEvent.inLogs(logs, 'TransactionRelayed', { status: RelayCallStatusCodes.RecipientBalanceChanged })
          }
        })
      })
    })
  })
})
