"use strict";

const AWS = require('aws-sdk');
const s3 = new AWS.S3();


const requestUpload = async(file_name, buffer, content_type) => {

    //[TASK] upload s3 image
    var s3_params = {
        Bucket: process.env.S3_IMGAE_BUCKET,
        Key: file_name,
        Body: buffer,
        ContentType: content_type
    };
    console.log('s3_params', s3_params)
    const s3_upload_result = await s3.upload(s3_params).promise().then(res => {
        console.log('s3_upload_result res', res)
        return res;
    }, err => {
        console.log('s3_upload_result err', err)
        return { error: err }
    })

    console.log('s3_upload_result', s3_upload_result)
    if (s3_upload_result.error) {
        console.log('s3_upload_result error', s3_upload_result.error)
        //2021 aws error
        return {
            result: false,
            data: s3_upload_result.error
        }
    }
    else {
        return {
            result: true,
            data: s3_upload_result
        }
    }

};

const requestGet = async(file_name) => {
    console.log('[requestGet] file_name', file_name)
    const s3_params = {
        Bucket: process.env.S3_IMGAE_BUCKET,
        Key: file_name,
    };
    console.log('[requestGet] s3_params', s3_params)

    const s3_get_result = await s3.getObject(s3_params).promise().then(res => {
        console.log('s3_get_result res', res)
        return res;

    }, err => {
        console.log('s3_get_result err', err)
        return { error: err }
    })
    if (s3_get_result.error) {
        console.log('s3_get_result error', s3_get_result.error)
        return {
            result: false,
            data: s3_get_result.error
        }
    }
    else {
        return {
            result: true,
            data: s3_get_result
        }
    }
}


const requestDelete = async(file_name) => {
    const s3_params = {
        Bucket: process.env.S3_IMGAE_BUCKET,
        Key: file_name,
    };
    const s3_delete_result = await s3.deleteObject(s3_params).promise().then(res => {
        console.log('s3_delete_result res', res)
        return res;

    }, err => {
        console.log('s3_delete_result err', err)
        return { error: err }
    })
    if (s3_delete_result.error) {
        console.log('s3_delete_result error', s3_delete_result.error)
        //2021 aws error
        return {
            result: false,
            data: s3_delete_result.error
        }
    }
    else {
        return {
            result: true,
            data: s3_delete_result
        }
    }
}






module.exports = { requestUpload, requestGet, requestDelete }
