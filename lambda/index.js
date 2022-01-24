"use strict";

const Busboy = require('busboy');
const AWS = require('aws-sdk');
const axios = require("axios").default;
const gm = require('gm').subClass({ imageMagick: true });
const fs = require('fs').promises;
const moment = require('moment-timezone');
const Base64 = require("js-base64");

const dbPool = require('../modules/util_rds_pool.js');
const dbQuery = require('../resource/sql.json');
const klipHandler = require('../modules/util_klip.js');
const s3Handler = require("../modules/util_s3.js");
const smHandler = require('../modules/util_sm.js');
const bbHandler = require('../modules/util_bb.js');
const psHandler = require('../modules/util_ps.js');

const { InsertLogSeq } = require("../modules/utils_error.js");

const kasInfo = require('../resource/kas.json');
const klipInfo = require('../resource/klip.json');

const VALIDATION_CONTENT_TYPE_LIST = ['image/jpeg', 'image/png', 'application/octet-stream'];
const DEFAULT_BG_IMAGE_PATH = ['default/bg_blue.png', 'default/bg_red.png', 'default/bg_green.png']

exports.handler = async function(event, context, callback) {
    console.log('event!', event)
    const resource = event.resource;
    const resourceDepth = resource.split('/');
    console.log('resourceDepth', resourceDepth);


    if (resourceDepth.length === 4 && resourceDepth[3] === 'sync') {
        //[Card Mint Sync]
        console.log('[nft_mint_sync]', event);
        try {
            const pool = await dbPool.getPool();
            const formData = await parse(event);
            const secretValue = await smHandler.getSecretValue(process.env.SM_ID);
            const klipSecretValue = await smHandler.getSecretValue(process.env.KLIP_SM_ID);
            console.log('formData', formData);

            const pass = formData.pass;
            const isMaintenance = await psHandler.getParameterStoreValue(process.env.PARAMETER_STORE_VALUE, 'backend', pass);
            console.log('isMaintenance', isMaintenance)
            if (isMaintenance) {
                return sendRes(callback, 400, { message: JSON.parse(Base64.decode(isMaintenance)).message, })
            }


            //[validation] parameter
            if (!formData.name ||
                !formData.description ||
                !formData.memberId ||
                !formData.memberGroupId ||
                !formData.traderId ||
                !formData.traderName ||
                !formData.type ||
                !formData.effectDate ||
                !formData.expireDate) {
                return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인' })
            }
            if (formData.traderName.length > 20) {
                return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인 - treaderName max length 20' })
            }

            if (!Date.parse(formData.effectDate) || !Date.parse(formData.expireDate)) {
                return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인 - effectDate, expireDate' })
            }

            if (formData.contentType) {
                if (!VALIDATION_CONTENT_TYPE_LIST.includes(formData.contentType)) {
                    return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인 - file png or jpeg' })
                }
            }

            //image file data
            // const s3_file_name = formData.name + '_' + formData.traderId + '_' + formData.memberId + '_' + formData.effectDate.substring(0, 10) + '~' + formData.expireDate.substring(0, 10) + '.png';
            const s3_file_name = formData.traderId + '/' + formData.memberId + '_' + formData.effectDate.substring(0, 10) + '_' + formData.expireDate.substring(0, 10) + '.png';

            const file_content_type = 'image/png';
            let file_buffer = formData.file;


            //nft data[required]
            const name = formData.name;
            const description = formData.description;
            const member_id = formData.memberId;
            const member_group_id = formData.memberGroupId;
            const trader_id = formData.traderId;
            const trader_name = formData.traderName;
            const type = formData.type;
            const effect_dt = moment(formData.effectDate).format('YYYY-MM-DD HH:mm:ss');
            const expire_dt = moment(formData.expireDate).format('YYYY-MM-DD HH:mm:ss');
            console.log('effect_dt', effect_dt);
            console.log('expire_dt', expire_dt);


            //nft date[optional]
            const memo = formData.memo || null;

            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] Auth Validation
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            const token = event.headers.Authorization;
            console.log('token', token)
            const tokenValidation = await bbHandler.requestValidation(token, member_id);
            console.log('tokenValidation', tokenValidation)
            if (!tokenValidation.result) {
                return sendRes(callback, 400, { code: 1012, message: '유효하지 않은 토큰입니다.', info: tokenValidation.data })
            }

            //[TASK] INSERT MEMO
            let memoResult = null;
            if (memo) {
                const [memoQueryResult, f3] = await pool.query(dbQuery.insert_memo.queryString, [memo]);
                memoResult = memoQueryResult;
            }
            console.log('[SQL] memoResult', memoResult);
            let memoSeq = null;
            if (memo && memoResult.affectedRows === 1) {
                memoSeq = parseInt(memoResult.insertId);
            }

            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] User, Token Validation
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            const [check_link, f1] = await pool.query(dbQuery.check_link.queryString, [member_id, member_group_id]);
            if (check_link.length == 0) {
                let errorBody = {
                    code: 1001,
                    message: 'Link 정보가 없습니다.',
                };
                console.log('[400] - (1001) Link 정보가 없습니다.');
                console.log('check_link', check_link);
                return sendRes(callback, 400, errorBody);
            }
            const link_num = check_link[0].link_num;
            const user_klip_address = check_link[0].klip_address;
            console.log('user_klip_address', user_klip_address)


            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] Image Generate
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            let randomIndex = Math.floor(Math.random() * 3); //0,1,2;
            console.log('randomIndex', randomIndex)
            // get default image
            let default_image_get = await s3Handler.requestGet(DEFAULT_BG_IMAGE_PATH[randomIndex]);
            console.log('default_image_get', default_image_get)
            let bg_image_buffer = null;
            if (default_image_get.result) {
                bg_image_buffer = default_image_get.data.Body;
            }
            else {
                return sendRes(callback, 400, { code: 2021, message: 'AWS API ERROR (S3)', info: default_image_get.data })
            }
            console.log('bg_image_buffer', bg_image_buffer)

            let file_path = null;
            console.log('file_buffer', file_buffer)
            let s3_img_buffer = null;
            if (file_buffer) {
                const circle_file_buffer = await generateCircle(file_buffer);
                console.log('circle_file_buffer', circle_file_buffer)

                //image composite를 할려면 로컬파일이 있어야해서 추가한 로직
                const now = moment(new Date()).tz('Asia/Seoul').format('YYYY-MM-DD HH:mm:ss');
                const temp_file_path = '/tmp/img' + now + '.png';
                const write_fs = await fs.writeFile(temp_file_path, circle_file_buffer).then((res) => {
                    console.log('res', res)
                }, err => {
                    console.log('err', err)
                });
                console.log('write_fs', write_fs)
                file_path = temp_file_path;

                const insert_bg_buffer = await insertTextImage(bg_image_buffer, trader_name, effect_dt, expire_dt);
                s3_img_buffer = await overlayImage(insert_bg_buffer, file_path)
            }
            else {
                s3_img_buffer = await insertTextImage(bg_image_buffer, trader_name, effect_dt, expire_dt);
            }

            console.log('s3_img_buffer', s3_img_buffer)

            //s3 upload
            let s3_upload = await s3Handler.requestUpload(s3_file_name, s3_img_buffer, file_content_type);
            let s3_image_url = null;

            if (s3_upload.result) {
                s3_image_url = s3_upload.data.Location;
            }
            else {
                return sendRes(callback, 400, { code: 7001, message: 'NFT Image Upload Fail (KLIP)', info: s3_upload.data })
            }

            //klip request upload
            const klipUploadImageResult = await klipHandler.requestUploadImage(s3_img_buffer);

            let klip_image_url = null;

            if (klipUploadImageResult.result) {
                klip_image_url = klipUploadImageResult.data.url;
            }
            else {
                //klip upload 실패시 업로드했던 s3 취소 후 에러메세지 리턴
                const s3_delete = await s3Handler.requestDelete(s3_file_name);
                console.log('s3_delete', s3_delete);

                return sendRes(callback, 400, { code: 7001, message: 'NFT Image Upload Fail (KLIP)', info: klipUploadImageResult.data })
            }
            console.log('klip_image_url', klip_image_url)

            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] Card Minting
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            //[TASK] 발행량 체크, insert concurrency 발생할 수 있기 때문에 Isnert 전에 확인
            const [nft_check_maximum_supply, f11] = await pool.query(dbQuery.nft_check_maximum_supply.queryString, [trader_id]);
            console.log('nft_check_maximum_supply', nft_check_maximum_supply)
            const currentNftCount = nft_check_maximum_supply[0].count;
            console.log('currentNftCount', currentNftCount)
            console.log('klipSecretValue.maximum_supply_count', klipSecretValue.maximum_supply_count)

            if (currentNftCount) {
                if (currentNftCount >= klipSecretValue.maximum_supply_count) {
                    let errorBody = {
                        code: 7003,
                        message: '해당 트레이더의 NFT발행량을 초과하였습니다.',
                    };
                    console.log('[400] - (7003) 해당 트레이더의 NFT발행량을 초과하였습니다.');
                    return sendRes(callback, 400, errorBody);
                }
            }

            //[TASK] 발급 가능한 유저인지 체크
            const [nft_check_member, f12] = await pool.query(dbQuery.nft_check_member.queryString, [member_id, member_group_id, trader_id]);
            console.log('nft_check_member', nft_check_member)
            if (nft_check_member.length > 0) {
                let errorBody = {
                    code: 7004,
                    message: '해당 유저는 해당 트레이더의 NFT를 발행할 수 없습니다.',
                };
                console.log('[400] - (7004) 해당 유저는 해당 트레이더의 NFT를 발행할 수 없습니다.');
                return sendRes(callback, 400, errorBody);
            }

            //[TASK] nft insert before_submit;
            const [nft_insert, f3] = await pool.query(dbQuery.nft_insert.queryString, [
                name,
                description,
                type,
                null, // tx_hash
                'before_submit',
                'ready',
                member_id,
                link_num,
                user_klip_address,
                trader_id,
                trader_name,
                klip_image_url,
                s3_image_url,
                effect_dt,
                expire_dt,
                memoSeq,
                null, //svc_callback_seq
                null, //transfer_seq
                null, //log_seq
            ]);

            const nft_insert_seq = nft_insert.insertId;
            console.log('nft_insert_seq', nft_insert_seq)

            //[TASK] request Card Mint
            //mbr_id, trader_id, trader_name,type: 'trader_card'
            const klipCardMintResult = await klipHandler.requestCardMint(
                user_klip_address,
                name,
                description,
                klip_image_url,
                effect_dt,
                expire_dt,
                trader_name,
                type,
            )
            let tx_hash = null;
            if (klipCardMintResult.result) {
                tx_hash = klipCardMintResult.data.hash;
            }
            else {
                console.log('[klipCardMintResult] 400 - response', klipCardMintResult)
                let errorBody = {
                    code: 7002,
                    message: 'NFT Card Mint Fail by (KLIP)',
                    info: klipCardMintResult.data
                };

                let code = klipCardMintResult.data.code || '';
                let message = klipCardMintResult.data.err || '';


                const [nft_update_tx_hash_status_fail, f3] = await pool.query(dbQuery.nft_update_tx_hash_status_job_end.queryString, [
                    tx_hash,
                    'fail',
                    'done',
                    nft_insert_seq
                ]);
                console.log('nft_update_tx_hash_status_fail', nft_update_tx_hash_status_fail)
                const nftLogSeq = await InsertLogSeq('nft', nft_insert_seq, 'KLIP', code, message);
                console.log('nftLogSeq', nftLogSeq)
                return sendRes(callback, 400, errorBody);
            }
            console.log('tx_hash', tx_hash);

            //[TASK] POLL Transaction check
            const satusCheckUrl = kasInfo.apiUrl + 'tx/' + tx_hash;
            const checkHeader = {
                'Authorization': secretValue.kas_authorization,
                'Content-Type': 'application/json',
                'x-chain-id': 8217,
            };

            const pollFn = () => {
                return axios.get(satusCheckUrl, { headers: checkHeader });
            };
            const pollTimeout = 5000;
            const pollInteval = 300;

            let updateTxStatus = null;
            let pollErrorCode = '';
            let pollErrorMessage = '';

            await poll(pollFn, pollTimeout, pollInteval).then(
                (res) => {
                    console.log('[poll] response', res);
                    var errorReg = new RegExp("CommitError");

                    if (res.status === 'Committed') {
                        updateTxStatus = 'success';
                    }
                    else if (errorReg.test(res.status)) {
                        updateTxStatus = 'fail';
                        pollErrorCode = res.txError || '';
                        pollErrorMessage = res.errorMessage || '';
                    }
                },
                (err) => {
                    console.log('[poll] error', err);
                    let errorData = err.data;
                    pollErrorCode = errorData.code || '';
                    pollErrorMessage = errorData.message || '';

                    if (pollErrorCode === 6000) {
                        // timeout의 경우 submit으로 async 모드로 시도할 수 있도록 한다.
                        updateTxStatus = 'submit';
                    }
                    else {
                        // updateTxStatus = 'fail'; 기존엔 에러나면 fail이었으나, KAS API에서 수시로 400에러를 떨어트려서, submit으로 변경
                        updateTxStatus = 'submit';
                    }
                },
            );

            console.log('[POLL - Result] updateTxStatus', updateTxStatus);

            // [TASK] Update Nft Status
            switch (updateTxStatus) {
                case 'success':
                    // code
                    let successResultBody = {
                        transactionHash: tx_hash,
                        nftSequence: nft_insert_seq,
                        tx_status: 'success',
                    };

                    const [nft_update_tx_hash_status_success, f1] = await pool.query(dbQuery.nft_update_tx_hash_status_job_end.queryString, [
                        tx_hash,
                        'success',
                        'done',
                        nft_insert_seq
                    ]);
                    console.log('nft_update_tx_hash_status_success', nft_update_tx_hash_status_success)
                    console.log('[success] response', successResultBody);
                    return sendRes(callback, 200, successResultBody);

                case 'submit':
                    let submitResultBody = {
                        transactionHash: tx_hash,
                        nftSequence: nft_insert_seq,
                        tx_status: 'submit',
                    };
                    const [nft_update_tx_hash_status_submit, f2] = await pool.query(dbQuery.nft_update_tx_hash_status_job.queryString, [
                        tx_hash,
                        'submit',
                        'ready',
                        nft_insert_seq
                    ]);
                    console.log('nft_update_tx_hash_status_submit', nft_update_tx_hash_status_submit)
                    console.log('[submit] response', submitResultBody);
                    return sendRes(callback, 200, submitResultBody);

                case 'fail':
                    let failResultBody = {
                        transactionHash: tx_hash,
                        nftSequence: nft_insert_seq,
                        tx_status: 'fail',
                        info: {
                            code: pollErrorCode,
                            message: pollErrorMessage
                        }
                    };
                    const [nft_update_tx_hash_status_fail, f3] = await pool.query(dbQuery.nft_update_tx_hash_status_job_end.queryString, [
                        tx_hash,
                        'fail',
                        'done',
                        nft_insert_seq
                    ]);
                    console.log('nft_update_tx_hash_status_fail', nft_update_tx_hash_status_fail)
                    console.log('[fail] response', failResultBody);
                    const nftLogSeq = await InsertLogSeq('nft', nft_insert_seq, 'KLIP', pollErrorCode, pollErrorMessage);
                    console.log('nftLogSeq', nftLogSeq)
                    return sendRes(callback, 400, failResultBody);

                default:
                    //예상 시나리오에 없는 케이스 => 직접 확인해야 하는 케이스
                    let unknownResultBody = {
                        transactionHash: tx_hash,
                        nftSequence: nft_insert_seq,
                        status: 'unknown'
                    };
                    const [nft_update_tx_hash_status_unknown, f4] = await pool.query(dbQuery.nft_update_tx_hash_status_job_end.queryString, [
                        tx_hash,
                        'unknown',
                        'done',
                        nft_insert_seq
                    ]);
                    console.log('nft_update_tx_hash_status_unknown', nft_update_tx_hash_status_unknown)
                    console.log('[success] response', unknownResultBody);
                    return sendRes(callback, 400, unknownResultBody);
            }

        }
        catch (err) {
            console.log('err', err)
            return sendRes(callback, 400, { code: 9000, message: 'Unexpected Error', info: err.message })
        }

    }
    else if (resourceDepth.length === 4 && resourceDepth[3] === 'async') {
        //[Card Mint Async]
        console.log('[nft_mint_sync]', event);
        try {
            const pool = await dbPool.getPool();
            const formData = await parse(event);
            const secretValue = await smHandler.getSecretValue(process.env.SM_ID);
            const klipSecretValue = await smHandler.getSecretValue(process.env.KLIP_SM_ID);

            console.log('formData', formData);

            const pass = formData.pass;
            const isMaintenance = await psHandler.getParameterStoreValue(process.env.PARAMETER_STORE_VALUE, 'backend', pass);
            console.log('isMaintenance', isMaintenance)
            if (isMaintenance) {
                return sendRes(callback, 400, { message: JSON.parse(Base64.decode(isMaintenance)).message, })
            }

            // upload image -> 발행량 체크 -> insert

            //[validation] parameter
            if (!formData.name ||
                !formData.description ||
                !formData.memberId ||
                !formData.memberGroupId ||
                !formData.traderId ||
                !formData.traderName ||
                !formData.type ||
                !formData.effectDate ||
                !formData.expireDate) {
                return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인' })
            }

            if (formData.traderName.length > 20) {
                return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인 - treaderName max length 20' })
            }

            if (!Date.parse(formData.effectDate) || !Date.parse(formData.expireDate)) {
                return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인 - effectDate, expireDate' })
            }

            if (formData.contentType) {
                if (!VALIDATION_CONTENT_TYPE_LIST.includes(formData.contentType)) {
                    return sendRes(callback, 400, { code: 3000, message: '요청 파라미터 확인 - file png or jpeg' })
                }
            }



            //image file data
            // const s3_file_name = formData.name + '_' + formData.traderId + '_' + formData.memberId + '_' + formData.effectDate.substring(0, 10) + '~' + formData.expireDate.substring(0, 10) + '.png';
            const s3_file_name = formData.traderId + '/' + formData.memberId + '_' + formData.effectDate.substring(0, 10) + '_' + formData.expireDate.substring(0, 10) + '.png';

            const file_content_type = 'image/png';
            const file_buffer = formData.file;
            //nft data[required]
            const name = formData.name;
            const description = formData.description;
            const member_id = formData.memberId;
            const member_group_id = formData.memberGroupId;
            const trader_id = formData.traderId;
            const trader_name = formData.traderName;
            const type = formData.type;

            const effect_dt = moment(formData.effectDate).format('YYYY-MM-DD HH:mm:ss');
            const expire_dt = moment(formData.expireDate).format('YYYY-MM-DD HH:mm:ss');

            //nft date[optional]
            const memo = formData.memo || null;
            const svc_callback_url = formData.serviceCallbackUrl ? decodeURIComponent(formData.serviceCallbackUrl) : null;


            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] Auth Validation
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            const token = event.headers.Authorization;
            console.log('token', token)
            const tokenValidation = await bbHandler.requestValidation(token, member_id);
            console.log('tokenValidation', tokenValidation)
            if (!tokenValidation.result) {
                return sendRes(callback, 400, { code: 1012, message: '유효하지 않은 토큰입니다.', info: tokenValidation.data })
            }

            //[TASK] INSERT MEMO
            let memoResult = null;
            if (memo) {
                const [memoQueryResult, f3] = await pool.query(dbQuery.insert_memo.queryString, [memo]);
                memoResult = memoQueryResult;
            }
            console.log('[SQL] memoResult', memoResult);
            let memoSeq = null;
            if (memo && memoResult.affectedRows === 1) {
                memoSeq = parseInt(memoResult.insertId);
            }

            //[TASK] INSERT ServiceCallbackUrl
            var svc_callback_seq = null;
            if (svc_callback_url) {
                const [createServiceCallbackResult, f3] = await pool.query(dbQuery.service_callback_insert.queryString, [svc_callback_url]);
                svc_callback_seq = parseInt(createServiceCallbackResult.insertId);

            }
            console.log('[SQL] svc_callback_seq', svc_callback_seq);


            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] User, Token Validation
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            const [check_link, f1] = await pool.query(dbQuery.check_link.queryString, [member_id, member_group_id]);
            if (check_link.length == 0) {
                let errorBody = {
                    code: 1001,
                    message: 'Link 정보가 없습니다.',
                };
                console.log('[400] - (1001) Link 정보가 없습니다.');
                console.log('check_link', check_link);
                return sendRes(callback, 400, errorBody);
            }
            const link_num = check_link[0].link_num;
            const user_klip_address = check_link[0].klip_address;
            console.log('user_klip_address', user_klip_address)

            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] Image Generate
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            let randomIndex = Math.floor(Math.random() * 3); //0,1,2;
            console.log('randomIndex', randomIndex)
            // get default image
            let default_image_get = await s3Handler.requestGet(DEFAULT_BG_IMAGE_PATH[randomIndex]);
            console.log('default_image_get', default_image_get)
            let bg_image_buffer = null;
            if (default_image_get.result) {
                bg_image_buffer = default_image_get.data.Body;
            }
            else {
                return sendRes(callback, 400, { code: 2021, message: 'AWS API ERROR (S3)', info: default_image_get.data })
            }
            console.log('bg_image_buffer', bg_image_buffer)

            let file_path = null;
            console.log('file_buffer', file_buffer)
            let s3_img_buffer = null;
            if (file_buffer) {

                const circle_file_buffer = await generateCircle(file_buffer);
                console.log('circle_file_buffer', circle_file_buffer)

                // This must run inside a function marked `async`:
                const now = moment(new Date()).tz('Asia/Seoul').format('YYYY-MM-DD HH:mm:ss');
                const temp_file_path = '/tmp/img' + now + '.png';
                const write_fs = await fs.writeFile(temp_file_path, circle_file_buffer).then((res) => {
                    console.log('res', res)
                }, err => {
                    console.log('err', err)
                });
                console.log('write_fs', write_fs)
                file_path = temp_file_path;

                const insert_bg_buffer = await insertTextImage(bg_image_buffer, trader_name, effect_dt, expire_dt);
                s3_img_buffer = await overlayImage(insert_bg_buffer, file_path)
            }
            else {
                s3_img_buffer = await insertTextImage(bg_image_buffer, trader_name, effect_dt, expire_dt);
            }

            console.log('s3_img_buffer', s3_img_buffer)

            //s3 upload
            let s3_upload = await s3Handler.requestUpload(s3_file_name, s3_img_buffer, 'image/png');
            let s3_image_url = null;

            if (s3_upload.result) {
                s3_image_url = s3_upload.data.Location;
            }
            else {
                return sendRes(callback, 400, { code: 7001, message: 'NFT Image Upload Fail (KLIP)', info: s3_upload.data })

            }

            //klip request upload
            const klipUploadImageResult = await klipHandler.requestUploadImage(s3_img_buffer);

            let klip_image_url = null;

            if (klipUploadImageResult.result) {
                klip_image_url = klipUploadImageResult.data.url;
            }
            else {
                //klip upload 실패시 업로드했던 s3 취소 후 에러메세지 리턴
                const s3_delete = await s3Handler.requestDelete(s3_file_name);
                console.log('s3_delete', s3_delete);

                return sendRes(callback, 400, { code: 7001, message: 'NFT Image Upload Fail (KLIP)', info: klipUploadImageResult.data })
            }
            console.log('klip_image_url', klip_image_url)


            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
            //[TASK] Card Minting
            ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

            //[TASK] 발행량 체크, insert concurrency 발생할 수 있기 때문에 Isnert 전에 확인
            const [nft_check_maximum_supply, f11] = await pool.query(dbQuery.nft_check_maximum_supply.queryString, [trader_id]);
            console.log('nft_check_maximum_supply', nft_check_maximum_supply)
            const currentNftCount = nft_check_maximum_supply[0].count;
            console.log('currentNftCount', currentNftCount)
            console.log('klipSecretValue.maximum_supply_count', klipSecretValue.maximum_supply_count)

            //[TASK] 발급 가능한 유저인지 체크
            const [nft_check_member, f12] = await pool.query(dbQuery.nft_check_member.queryString, [member_id, member_group_id, trader_id]);
            console.log('nft_check_member', nft_check_member)
            if (nft_check_member.length > 0) {
                let errorBody = {
                    code: 7004,
                    message: '해당 유저는 해당 트레이더의 NFT를 발행할 수 없습니다.',
                };
                console.log('[400] - (7004) 해당 유저는 해당 트레이더의 NFT를 발행할 수 없습니다.');
                return sendRes(callback, 400, errorBody);
            }

            if (currentNftCount) {
                if (currentNftCount >= klipSecretValue.maximum_supply_count) {
                    let errorBody = {
                        code: 7003,
                        message: '해당 트레이더의 NFT발행량을 초과하였습니다.',
                    };
                    console.log('[400] - (7003) 해당 트레이더의 NFT발행량을 초과하였습니다.');
                    return sendRes(callback, 400, errorBody);
                }
            }

            //[TASK] nft insert before_submit;
            const [nft_insert, f3] = await pool.query(dbQuery.nft_insert.queryString, [
                name,
                description,
                type,
                null, // tx_hash
                'before_submit',
                'ready',
                member_id,
                link_num,
                user_klip_address,
                trader_id,
                trader_name,
                klip_image_url,
                s3_image_url,
                effect_dt,
                expire_dt,
                memoSeq,
                null, //svc_callback_seq
                null, //transfer_seq
                null, //log_seq
            ]);

            const nft_insert_seq = nft_insert.insertId;
            console.log('nft_insert_seq', nft_insert_seq)

            //[TASK] request Card Mint
            const klipCardMintResult = await klipHandler.requestCardMint(
                user_klip_address,
                name,
                description,
                klip_image_url,
                effect_dt,
                expire_dt,
                trader_name,
                type, );

            let tx_hash = null;

            if (klipCardMintResult.result) {
                tx_hash = klipCardMintResult.data.hash;
            }
            else {
                console.log('[klipCardMintResult] 400 - response', klipCardMintResult)
                let errorBody = {
                    code: 7002,
                    message: 'NFT Card Mint Fail by (KLIP)',
                    info: klipCardMintResult.data
                };

                let code = klipCardMintResult.data.code || '';
                let message = klipCardMintResult.data.err || '';

                const [nft_update_tx_hash_status, f1] = await pool.query(dbQuery.nft_update_tx_hash_status_job_end.queryString, [
                    tx_hash,
                    'fail',
                    'done',
                    nft_insert_seq
                ]);
                console.log('nft_update_tx_hash_status', nft_update_tx_hash_status)
                const nftLogSeq = await InsertLogSeq('nft', nft_insert_seq, 'KLIP', code, message);
                console.log('nftLogSeq', nftLogSeq)
                return sendRes(callback, 400, errorBody);
            }

            let successResultBody = {
                transactionHash: tx_hash,
                nftSequence: nft_insert_seq,
                tx_status: 'submit',
            };

            const [nft_update_tx_hash_status_success, f21] = await pool.query(dbQuery.nft_update_tx_hash_status_job.queryString, [
                tx_hash,
                'submit',
                'ready',
                nft_insert_seq
            ]);
            console.log('nft_update_tx_hash_status_success', nft_update_tx_hash_status_success)
            console.log('[success] response', successResultBody);
            return sendRes(callback, 200, successResultBody);


        }
        catch (err) {
            console.log('err', err)
            return sendRes(callback, 400, { code: 9000, message: 'Unexpected Error', info: err.message })
        }
    }
    else {
        return sendRes(callback, 400, { result: true, message: 'none' });

    }

}

const generateCircle = async(buffer) => {
    const max = 141;
    return new Promise((resolve, reject) => {
        gm(buffer)
            .autoOrient()
            .gravity('Center')
            .resize(max, max, '^')
            .extent(max, max)
            .noProfile()
            .setFormat('png')
            .out('(')
            .rawSize(max, max)
            .out('xc:Black')
            .fill('White')
            .drawCircle(max / 2, max / 2, max / 2, 1)
            .out('-alpha', 'Copy')
            .out(')')
            .compose('CopyOpacity')
            .out('-composite')
            .trim()
            .toBuffer((err, buf) => err ? reject(err) : resolve(buf))
    })
}

const insertTextImage = async(buffer, creator_text, effect_dt, expire_dt) => {
    const effect_dt_str = effect_dt.substring(0, 10);
    const expired_dt_str = expire_dt.substring(0, 10);
    console.log('[insertTextImage] effect_dt_str', effect_dt_str)
    console.log('[insertTextImage] expired_dt_str', expired_dt_str)
    const subText = `${effect_dt_str} ~ ${expired_dt_str}`
    return new Promise((resolve, reject) => {
        gm(buffer)
            .fill('#171d30')
            .font('./NotoSansCJKkr-Bold.ttf', 33)
            .drawText(0, 58, creator_text, 'Center') // 276-228 = 48 
            .fill('#171d30')
            .font('./Roboto-Regular.ttf', 21)
            .drawText(0, 195, subText, 'Center') // 423-228 = 195
            .toBuffer((err, buf) => err ? reject(err) : resolve(buf))
    })
}

const overlayImage = async(bg_buffer, file_path) => {
    return new Promise((resolve, reject) => {
        gm(bg_buffer)
            .composite(file_path)
            .geometry("+159+114")
            .toBuffer((err, buf) => err ? reject(err) : resolve(buf))
    })
}

const getContentType = (event) => {
    let contentType = event.headers['content-type']
    if (!contentType) {
        return event.headers['Content-Type'];
    }
    return contentType;
};

const parse = (event) => new Promise((resolve, reject) => {
    console.log('event.body.toString()', event.body.toString());

    const bodyBuffer = new Buffer.from(event.body.toString(), "base64");
    console.log('bodyBuffer', bodyBuffer)
    const busboy = new Busboy({
        headers: {
            'content-type': getContentType(event),
        }
    });
    console.log('busboy', busboy)
    const result = {};

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        file.on('data', data => {
            console.log('data', data)
            result.file = data;
        });

        file.on('end', () => {
            console.log('end', file)
            console.log('filename', filename)
            console.log('encoding', encoding)
            console.log('mimetype', mimetype)
            result.filename = filename;
            result.contentType = mimetype;
        });
    });

    busboy.on('field', (fieldname, value) => {
        console.log('fieldname', fieldname)
        console.log('value', value)
        result[fieldname] = value;
    });

    busboy.on('error', error => reject(`Parse error: ${error}`));
    busboy.on('finish', () => resolve(result));

    busboy.write(bodyBuffer, event.isBase64Encoded ? 'base64' : 'binary');
    busboy.end();
});

function poll(fn, timeout, interval) {
    var endTime = Number(new Date()) + (timeout || 2000);
    interval = interval || 100;

    var checkCondition = function(resolve, reject) {
        var ajax = fn();
        // dive into the ajax promise
        ajax.then(function(response) {
            // If the condition is met, we're done!
            console.log('[POLL] condiftion response', response);

            console.log('[POLL] condiftion status', response.data.status);
            var errorReg = new RegExp("CommitError");

            if (response.data.status === 'Committed') {
                resolve(response.data);
            }
            else if (errorReg.test(response.data.status)) {
                resolve(response.data);
            }
            else if (Number(new Date()) < endTime) {
                // pending은 지속적으로 polling
                setTimeout(checkCondition, interval, resolve, reject);
            }
            else {
                //time out case
                console.log('time out case');
                let errorRespone = {
                    code: 6000,
                    message: 'poll-time out'
                }
                let error = new Error();
                error = { ...error, data: errorRespone };
                reject(error);
            }
        }).catch(function(err) {
            console.log('[POLL] err', err);
            let errorRespone = err.response.data;
            let error = new Error();
            error = { ...error, data: errorRespone };
            reject(error);

        })
    };

    return new Promise(checkCondition);
}
const sendRes = (callback, statusCode, body) => {
    const response = {
        statusCode: statusCode,
        headers: {
            "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify(body)
    };

    return response;
}
