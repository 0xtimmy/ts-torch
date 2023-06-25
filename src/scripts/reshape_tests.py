import torch
import torch.nn.functional as F
import numpy

# Each gen function should return a json object of the below form
# These will be passed to tester.ts and run against our ts-torch

#interface test {
#    "message": string,         // the message to go along with the test
#    "func": string,            // the function being tested
#    "args": any,               // the arguements to be passed to the function
#    "target": any,             // the desired output
#    "log"?: logconfig,         // whether to log the test or not
#    "log_config"?: logconfig,  // whether to log the test arguements and output
#}

def gen_chunk(message, input, chunks, dim, log="always", log_config="fail"):
    output = torch.chunk(input, chunks, dim)
    return {
        "message": message,
        "func": "chunk",
        "args": {
            "input": input.numpy().tolist(),
            "chunks": chunks,
            "dim": dim,
        },
        "target": [t.numpy().tolist() for t in output],
        "log": log,
        "log_config": log_config
    }


def gen_transpose(message, input, dim0=0, dim1=1, log="always", log_config="fail"):
    output = input.transpose(dim0, dim1)
    return {
        "message": message,
        "func": "transpose",
        "args": {
            "input": input.numpy().tolist(),
            "dim0": dim0,
            "dim1": dim1,
        },
        "target": output.numpy().tolist(),
        "log": log,
        "log_config": log_config
    }
    

def gen_unsqueeze(message, shape, dim, log="always", log_config="fail"):
    input = torch.randint(0, 9, shape)
    output = input.unsqueeze(dim)
    return {
        "message": message,
        "func": "unsqueeze",
        "args": { "input": input.numpy().tolist(), "dim": dim },
        "target": output.numpy().tolist(),
        "log": log,
        "log_config": log_config
    }

def gen_squeeze(message, shape, dim=None, log="always", log_config="fail"):
    input = torch.randint(0, 9, shape)
    if dim : 
        output = input.squeeze(dim)
    else :
        output = input.squeeze()
    return {
        "message": message,
        "func": "squeeze",
        "args": { "input": input.numpy().tolist(), "dim": dim },
        "target": output.numpy().tolist(),
        "log": log,
        "log_config": log_config
    }
